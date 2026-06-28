import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

import { readJsonl } from "./json.js";
import { copilotLogDir, copilotTranscriptPath, tracePath, workspaceRoot } from "./paths.js";
import { readCopilotOtelEvents } from "./otel.js";
import { startLiveObserver } from "./observer.js";
import { buildInjectionPlan } from "./retrieval.js";
import { claimInvocationLock } from "./invocation-lock.js";
import { isArcSidecarSession, reviewEvents } from "./review.js";
import { debug, saveTraceEvents } from "./store.js";
import { installCopilotPromptHook } from "./install.js";
import { copilotCommand } from "./copilot-command.js";
import type { ArcEvent } from "./types.js";

export { reviewEvents } from "./review.js";
export type { ReviewOutcome } from "./review.js";

export async function importCopilotTranscript(path: string, workspace = workspaceRoot(), fallbackSessionId = "unknown"): Promise<ArcEvent[]> {
  const events = await readCopilotTranscriptEvents(path, workspace, fallbackSessionId);
  const sessionId = events[0]?.sessionId ?? fallbackSessionId;
  await saveTraceEvents(events, sessionId, workspace);
  return events;
}

export async function importCopilotOtel(path: string, workspace = workspaceRoot(), fallbackSessionId = "unknown"): Promise<ArcEvent[]> {
  const events = await readCopilotOtelEvents(path, workspace, fallbackSessionId);
  const sessionId = events[0]?.sessionId ?? fallbackSessionId;
  await saveTraceEvents(events, sessionId, workspace);
  await debug("otel.imported", { sessionId, eventCount: events.length, path }, workspace);
  return events;
}

export async function readCopilotTranscriptEvents(path: string, workspace = workspaceRoot(), fallbackSessionId = "unknown"): Promise<ArcEvent[]> {
  const rawEvents = await readJsonl<Record<string, unknown>>(path);
  if (rawEvents.every(isStoredArcEvent)) {
    return rawEvents.map((event, index) => normalizeStoredArcEvent(event, index, workspace, fallbackSessionId));
  }
  const sessionId = sessionIdFromEvents(rawEvents) ?? fallbackSessionId;
  return rawEvents.map((raw, index) => normalizeCopilotRecord(raw, index, sessionId, workspace));
}

export async function launchCopilot(args: string[], workspace = workspaceRoot()): Promise<number> {
  if (process.env.AGENT_RUN_CACHE_INSTALL_HOOKS !== "0") {
    await installCopilotPromptHook(workspace).catch((error) => debug("copilot.hook_install_failed", { error: String(error) }, workspace));
  }
  const explicitSessionId = valueAfter(args, "--session-id");
  const launchId = explicitSessionId ?? `native-${randomUUID()}`;
  const launchStartedAt = Date.now();
  const otelPath = process.env.COPILOT_OTEL_FILE_EXPORTER_PATH ?? tracePath(launchId, workspace).replace(/\.jsonl$/, ".otel.jsonl");
  const originalPrompt = promptFromArgs(args);
  const injection = originalPrompt ? await buildInjectionPlan(originalPrompt, workspace, { runner: "copilot", sessionId: launchId }) : { shouldInject: false, message: "", reason: "no initial prompt" };
  const finalArgs = prepareCopilotArgs(args, launchId, workspace, injection.shouldInject ? injection.message : "");
  const launcher = copilotCommand(finalArgs);
  await debug("session.detected", { launchId, explicitSessionId, source: "copilot.launch" }, workspace);
  await debug("copilot.launch", { sessionId: launchId, nativeSession: !explicitSessionId, wrapped: injection.shouldInject, reason: injection.reason, command: launcher.label, args: redactArgs(launcher.args), otelPath }, workspace);
  const observer = !explicitSessionId || process.env.AGENT_RUN_CACHE_LIVE_OBSERVER === "0"
    ? null
    : startLiveObserver({
      sessionId: explicitSessionId,
      workspace,
      readEvents: () => readCopilotTranscriptEvents(copilotTranscriptPath(explicitSessionId), workspace, explicitSessionId)
    });

  const child = spawn(launcher.command, launcher.args, {
    cwd: workspace,
    stdio: "inherit",
    env: {
      ...process.env,
      COPILOT_OTEL_EXPORTER_TYPE: process.env.COPILOT_OTEL_EXPORTER_TYPE ?? "file",
      COPILOT_OTEL_FILE_EXPORTER_PATH: otelPath,
      OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT:
        process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT ?? "false"
    }
  });

  const exitCode = await new Promise<number>((resolve) => {
    child.on("exit", (code) => resolve(code ?? 0));
  });

  await observer?.stop();
  const sessionId = explicitSessionId ?? await latestCopilotSessionIdSince(launchStartedAt - 2000, workspace);
  let transcriptHarvested = false;
  if (sessionId) transcriptHarvested = await harvestSession(sessionId, workspace);
  else await debug("copilot.native_session_not_found", { launchId }, workspace);
  await harvestOtelFallback(otelPath, workspace, sessionId ?? launchId, transcriptHarvested);
  return exitCode;
}

export async function harvestSession(sessionId: string, workspace = workspaceRoot()): Promise<boolean> {
  const transcript = copilotTranscriptPath(sessionId);
  if (!existsSync(transcript)) {
    await debug("copilot.transcript_missing", { sessionId, transcript }, workspace);
    await debug("review.skipped", { sessionId, reason: "transcript missing", source: "copilot-transcript" }, workspace);
    return false;
  }
  const events = await readCopilotTranscriptEvents(transcript, workspace, sessionId);
  if (isArcSidecarSession(events)) {
    await debug("copilot.sidecar_session_skipped", { sessionId, eventCount: events.length }, workspace);
    await debug("review.skipped", { sessionId, reason: "arc sidecar session", source: "copilot-transcript", eventCount: events.length }, workspace);
    return false;
  }
  if (!await claimInvocationLock(workspace, "copilot-session-end", [sessionId])) {
    await debug("copilot.harvest_skipped", { sessionId, reason: "duplicate session-end capture" }, workspace);
    return false;
  }
  await saveTraceEvents(events, sessionId, workspace);
  await debug("transcript.harvested", { sessionId, eventCount: events.length, transcript }, workspace);
  await reviewEvents(events, workspace, sessionId);
  return true;
}

async function harvestOtelFallback(path: string, workspace: string, fallbackSessionId: string, transcriptHarvested: boolean): Promise<boolean> {
  if (!existsSync(path)) {
    await debug("otel.skipped", { fallbackSessionId, reason: "otel file missing", path }, workspace);
    return false;
  }
  if (transcriptHarvested && process.env.AGENT_RUN_CACHE_REVIEW_OTEL_AFTER_TRANSCRIPT !== "1") {
    await debug("otel.skipped", { fallbackSessionId, reason: "transcript already harvested", path }, workspace);
    return false;
  }
  const events = await importCopilotOtel(path, workspace, fallbackSessionId);
  if (!events.length) {
    await debug("otel.skipped", { fallbackSessionId, reason: "no reviewable otel events", path }, workspace);
    return false;
  }
  const sessionId = events[0]?.sessionId ?? fallbackSessionId;
  await debug("otel.harvested", { sessionId, fallbackSessionId, eventCount: events.length, path }, workspace);
  await reviewEvents(events, workspace, sessionId);
  return true;
}

function prepareCopilotArgs(args: string[], launchId: string, workspace: string, injection: string): string[] {
  const next = [...args];
  if (!hasArg(next, "--log-dir")) next.push("--log-dir", copilotLogDir(launchId, workspace));
  if (!hasArg(next, "--log-level")) next.push("--log-level", "all");
  if (!hasArg(next, "--no-auto-update")) next.push("--no-auto-update");
  if (injection) wrapPromptArg(next, injection);
  return next;
}

async function latestCopilotSessionIdSince(sinceMs: number, workspace: string): Promise<string | null> {
  const root = process.env.AGENT_RUN_CACHE_COPILOT_STATE_DIR ?? join(homedir(), ".copilot", "session-state");
  let best: { sessionId: string; mtimeMs: number } | null = null;
  try {
    const entries = await readdir(root, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const eventsPath = join(root, entry.name, "events.jsonl");
      if (!existsSync(eventsPath)) continue;
      const info = await stat(eventsPath);
      if (info.mtimeMs < sinceMs) continue;
      if (best && info.mtimeMs <= best.mtimeMs) continue;
      if (!await transcriptBelongsToWorkspace(eventsPath, workspace)) continue;
      best = { sessionId: entry.name, mtimeMs: info.mtimeMs };
    }
  } catch (error) {
    await debug("copilot.native_session_scan_failed", { error: String(error), root }, workspace);
  }
  return best?.sessionId ?? null;
}

async function transcriptBelongsToWorkspace(path: string, workspace: string): Promise<boolean> {
  try {
    const text = await readFile(path, "utf8");
    const first = text.split(/\r?\n/, 1)[0];
    if (!first) return false;
    const record = JSON.parse(first) as { data?: { context?: { cwd?: string; gitRoot?: string } } };
    const cwd = record.data?.context?.cwd;
    const gitRoot = record.data?.context?.gitRoot;
    return cwd === workspace || gitRoot === workspace;
  } catch {
    return false;
  }
}

function promptFromArgs(args: string[]): string | null {
  for (const flag of ["-p", "--prompt", "-i", "--interactive"]) {
    const value = valueAfter(args, flag);
    if (value) return value;
  }
  return null;
}

function wrapPromptArg(args: string[], injection: string): void {
  for (const flag of ["-p", "--prompt", "-i", "--interactive"]) {
    const index = args.indexOf(flag);
    if (index >= 0 && args[index + 1]) {
      args[index + 1] = `${injection}\n\nUser task:\n${args[index + 1]}`;
      return;
    }
  }
}

function valueAfter(args: string[], flag: string): string | null {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] ?? null : null;
}

function hasArg(args: string[], flag: string): boolean {
  return args.includes(flag);
}

function sessionIdFromEvents(events: Record<string, unknown>[]): string | null {
  for (const event of events) {
    const data = event.data as Record<string, unknown> | undefined;
    if (typeof data?.sessionId === "string") return data.sessionId;
  }
  return null;
}

export function normalizeCopilotRecord(raw: Record<string, unknown>, index: number, sessionId: string, workspace: string, source = "copilot-transcript"): ArcEvent {
  const rawType = String(raw.type ?? "unknown");
  const data = (raw.data && typeof raw.data === "object" ? raw.data : {}) as Record<string, unknown>;
  const timestamp = typeof raw.timestamp === "string" ? raw.timestamp : new Date().toISOString();
  const base = {
    id: String(raw.id ?? `${sessionId}-${index}`),
    runner: "copilot" as const,
    sessionId,
    workspace,
    timestamp,
    source,
    rawType,
    raw
  };

  if (rawType === "session.start") return { ...base, type: "session_start" };
  if (rawType === "session.shutdown") return { ...base, type: "session_end", text: JSON.stringify(data).slice(0, 2000) };
  if (rawType === "assistant.message") return { ...base, type: "assistant_message", text: textValue(data.content) };
  if (rawType === "user.message") return { ...base, type: "user_prompt", text: userMessageText(data) };
  if (rawType === "hook.start") {
    const input = data.input as Record<string, unknown> | undefined;
    if (data.hookType === "userPromptSubmitted" && typeof input?.prompt === "string") {
      return { ...base, type: "user_prompt", text: input.prompt };
    }
  }

  const toolName = textValue(data.toolName ?? data.name ?? data.command);
  const toolUseId = textValue(data.toolUseId ?? data.id ?? data.callId);
  const command = commandFrom(data);
  if (rawType.includes("tool") && (toolName || command || rawType.includes("complete"))) {
    const complete = rawType.includes("end") || rawType.includes("complete");
    const resultText = textValue(data.result) || textValue(data.toolResult) || JSON.stringify(data).slice(0, 3000);
    const exitCode = exitCodeFromText(resultText);
    const success = typeof data.success === "boolean" ? data.success : undefined;
    const toolStatus = exitCode !== null ? exitCode === 0 ? "success" : "failed" : success === false ? "failed" : success === true ? "success" : "unknown";
    return {
      ...base,
      type: complete ? "tool_end" : "tool_start",
      toolName: toolName || "tool",
      toolUseId,
      command,
      text: complete ? resultText : JSON.stringify(data).slice(0, 3000),
      toolStatus,
      exitCode: exitCode ?? undefined
    };
  }
  return { ...base, type: "unknown", text: JSON.stringify(data).slice(0, 1000) };
}

function isStoredArcEvent(raw: Record<string, unknown>): boolean {
  return typeof raw.sessionId === "string" && typeof raw.type === "string" && typeof raw.timestamp === "string" && typeof raw.source === "string";
}

function normalizeStoredArcEvent(raw: Record<string, unknown>, index: number, workspace: string, fallbackSessionId: string): ArcEvent {
  const sessionId = typeof raw.sessionId === "string" ? raw.sessionId : fallbackSessionId;
  const eventType = typeof raw.type === "string" ? isArcEventType(raw.type) : false;
  if (eventType === "unknown" && raw.raw && typeof raw.raw === "object") {
    const upgraded = normalizeCopilotRecord(raw.raw as Record<string, unknown>, index, sessionId, workspace);
    if (upgraded.type !== "unknown") return { ...upgraded, id: typeof raw.id === "string" ? raw.id : upgraded.id, timestamp: typeof raw.timestamp === "string" ? raw.timestamp : upgraded.timestamp };
  }
  return {
    id: typeof raw.id === "string" ? raw.id : `${sessionId}-${index}`,
    runner: "copilot",
    sessionId,
    workspace,
    timestamp: typeof raw.timestamp === "string" ? raw.timestamp : new Date().toISOString(),
    type: eventType || "unknown",
    source: typeof raw.source === "string" ? raw.source : "copilot-transcript",
    text: typeof raw.text === "string" ? raw.text : undefined,
    toolName: typeof raw.toolName === "string" ? raw.toolName : undefined,
    toolUseId: typeof raw.toolUseId === "string" ? raw.toolUseId : undefined,
    command: typeof raw.command === "string" ? raw.command : undefined,
    path: typeof raw.path === "string" ? raw.path : undefined,
    toolStatus: raw.toolStatus === "success" || raw.toolStatus === "failed" || raw.toolStatus === "unknown" ? raw.toolStatus : undefined,
    exitCode: typeof raw.exitCode === "number" ? raw.exitCode : undefined,
    rawType: typeof raw.rawType === "string" ? raw.rawType : undefined,
    raw: raw.raw
  };
}

function isArcEventType(type: string): ArcEvent["type"] | false {
  if (type === "session_start" || type === "user_prompt" || type === "assistant_message" || type === "tool_start" || type === "tool_end" || type === "session_end" || type === "unknown") return type;
  return false;
}

function userMessageText(data: Record<string, unknown>): string {
  const content = textValue(data.content);
  const marker = "\n\nUser task:\n";
  const markerIndex = content.lastIndexOf(marker);
  if (markerIndex >= 0) return stripTrailingSystemText(content.slice(markerIndex + marker.length));
  return stripTrailingSystemText(content);
}

function stripTrailingSystemText(value: string): string {
  const marker = "\n\n<system_reminder>";
  const index = value.indexOf(marker);
  return index >= 0 ? value.slice(0, index).trim() : value.trim();
}

function commandFrom(data: Record<string, unknown>): string {
  const direct = textValue(data.command);
  if (direct) return direct;
  const args = data.arguments ?? data.args ?? data.input;
  if (typeof args === "object" && args) {
    const record = args as Record<string, unknown>;
    return textValue(record.command ?? record.cmd ?? record.script);
  }
  return "";
}

function textValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(textValue).filter(Boolean).join("\n");
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return textValue(record.text ?? record.content ?? record.message);
  }
  return "";
}

function exitCodeFromText(text: string): number | null {
  const match = text.match(/\bexit\s+code:?\s+(-?\d+)\b/i) ?? text.match(/\bexited\s+with\s+exit\s+code\s+(-?\d+)\b/i);
  return match ? Number(match[1]) : null;
}

function redactArgs(args: string[]): string[] {
  return args.map((arg) => (arg.length > 220 ? `${arg.slice(0, 220)}...` : arg));
}
