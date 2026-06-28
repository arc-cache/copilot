import { readFile } from "node:fs/promises";

import { normalizeCopilotRecord } from "./copilot.js";
import { buildCopilotPromptInjection, type InjectionPlanSummary } from "./copilot-injection.js";
import { claimInvocationLock, writeInvocationMarker } from "./invocation-lock.js";
import { recordMemoryEvent } from "./ledger.js";
import { activationPath, isWorkspaceActivated, workspaceRoot } from "./paths.js";
import { reviewEvents } from "./review.js";
import { debug, loadCapsules, saveTraceEvents } from "./store.js";
import { loadArcUiViewModel } from "./ui-data.js";
import type { ArcEvent, SidecarReviewOptions } from "./types.js";

type JsonRecord = Record<string, unknown>;

interface ExtensionPayload {
  input?: JsonRecord;
  invocation?: JsonRecord;
  capabilities?: JsonRecord;
  sessionId?: string;
  workspacePath?: string;
  captured?: unknown[];
  injectionPlans?: InjectionPlanSummary[];
  context?: JsonRecord;
}

export async function handleCopilotExtension(args: string[]): Promise<Record<string, unknown>> {
  const subcommand = args[0];
  if (subcommand === "hook") return handleExtensionHook(args[1] ?? "unknown", await readStdinJson());
  if (subcommand === "session-end") return handleExtensionSessionEnd(await readStdinJson());
  if (subcommand === "command") return handleExtensionCommand(args[1] ?? "arc", await readStdinJson());
  if (subcommand === "canvas-data") return handleExtensionCanvasData(await readStdinJson());
  if (subcommand === "loaded") return handleExtensionLoaded(await readStdinJson());
  throw new Error("Usage: arc extension hook|session-end|command|canvas-data|loaded");
}

async function handleExtensionLoaded(payload: ExtensionPayload): Promise<Record<string, unknown>> {
  const workspace = workspaceFromPayload(payload);
  if (!isWorkspaceActivated(workspace)) return { active: false };
  const capabilities = payload.capabilities ?? {};
  const sessionId = stringValue(payload.sessionId);
  if (sessionId) await writeInvocationMarker(workspace, "copilot-sdk-active", [sessionId]);
  if (sessionId) {
    const firstLoaded = await claimInvocationLock(workspace, "sdk-loaded", [sessionId]);
    if (!firstLoaded) return { active: false };
  }
  await debug("copilot_extension.loaded", {
    sessionId,
    capabilities,
    canvases: capabilityBoolean(capabilities, "canvases"),
    workspacePath: payload.workspacePath
  }, workspace);
  return {
    active: true,
    notice: `ARC extension loaded; canvases=${capabilityBoolean(capabilities, "canvases") ? "true" : "false"}`
  };
}

async function handleExtensionHook(hookName: string, payload: ExtensionPayload): Promise<Record<string, unknown>> {
  const input = recordValue(payload.input);
  const invocation = recordValue(payload.invocation);
  const workspace = workspaceFromPayload(payload);
  if (!isWorkspaceActivated(workspace)) return { hookResult: {} };
  const sessionId = stringValue(invocation.sessionId) || stringValue(input.sessionId) || "unknown";

  if (hookName === "session-start") {
    if (!await claimInvocationLock(workspace, "sdk-hook", [hookName, sessionId])) {
      await debug("copilot_extension.hook_skipped", { hookName, sessionId, reason: "duplicate invocation" }, workspace);
      return { hookResult: {} };
    }
    await debug("copilot_extension.session_start", {
      sessionId,
      capabilities: payload.capabilities ?? {},
      canvases: capabilityBoolean(payload.capabilities, "canvases")
    }, workspace);
    return { hookResult: {} };
  }

  if (hookName === "user-prompt") {
    const prompt = stringValue(input.prompt);
    if (!await claimInvocationLock(workspace, "sdk-hook", [hookName, sessionId, prompt], 30_000)) {
      await debug("copilot_extension.hook_skipped", { hookName, sessionId, reason: "duplicate invocation" }, workspace);
      return { hookResult: {} };
    }
    const injection = await buildCopilotPromptInjection(prompt, workspace, sessionId, "sdk-extension");
    return {
      hookResult: injection.hookResult,
      notice: injection.notice,
      plan: injection.plan
    };
  }

  return { hookResult: {} };
}

async function handleExtensionSessionEnd(payload: ExtensionPayload): Promise<Record<string, unknown>> {
  const input = recordValue(payload.input);
  const invocation = recordValue(payload.invocation);
  const workspace = workspaceFromPayload(payload);
  if (!isWorkspaceActivated(workspace)) return { hookResult: {} };
  const sessionId = stringValue(invocation.sessionId) || stringValue(input.sessionId) || "unknown";
  if (!await claimInvocationLock(workspace, "copilot-session-end", [sessionId])) {
    await debug("copilot_extension.session_end_skipped", { sessionId, reason: "duplicate invocation" }, workspace);
    return { hookResult: {} };
  }
  const events = normalizeExtensionEvents(payload, sessionId, workspace);
  if (!events.length) {
    await debug("copilot_extension.review_skipped", { sessionId, reason: "no captured events" }, workspace);
    return { hookResult: {}, notice: "ARC capture skipped: no reviewable session events" };
  }
  await saveTraceEvents(events, sessionId, workspace);
  await recordMemoryEvent({
    type: "runner.completed",
    workspace,
    sessionId,
    details: {
      runner: "copilot",
      surface: "sdk-extension",
      eventCount: events.length,
      capabilities: payload.capabilities ?? {}
    }
  });
  await debug("copilot_extension.session_end", {
    sessionId,
    eventCount: events.length,
    injectedCapsuleIds: injectedCapsuleIds(payload.injectionPlans),
    canvases: capabilityBoolean(payload.capabilities, "canvases")
  }, workspace);
  const outcome = await reviewEvents(events, workspace, sessionId, "auto", reviewOptionsFromPlans(payload.injectionPlans ?? []));
  const notices = outcome.status === "saved"
    ? [`ARC saved ${outcome.capsuleIds?.length ?? 0} capsule${outcome.capsuleIds?.length === 1 ? "" : "s"}`]
    : [];
  return {
    hookResult: {},
    notices,
    outcome
  };
}

async function handleExtensionCommand(command: string, payload: ExtensionPayload): Promise<Record<string, unknown>> {
  const workspace = workspaceFromPayload(payload);
  if (!isWorkspaceActivated(workspace)) {
    return { text: `ARC is not active for ${workspace}. Install the Copilot plugin with arc plugin install, then launch Copilot normally.` };
  }
  const model = await loadArcUiViewModel(workspace, { eventLimit: 5 });
  const capabilities = payload.capabilities ?? {};
  const canvas = capabilityBoolean(capabilities, "canvases");
  const lines = [
    "ARC status",
    `workspace: ${model.status.workspace}`,
    `capsules: ${model.status.capsuleCount}`,
    `events: ${model.status.eventCount}`,
    `last injection: ${model.status.lastInjection?.detail || "none"}`,
    `last save: ${model.status.lastSave?.detail || "none"}`,
    `canvases: ${canvas ? "true" : "false"}`
  ];
  if (command === "arc") {
    const capsules = await loadCapsules(workspace);
    for (const capsule of capsules.slice().sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)).slice(0, 3)) {
      lines.push(`- ${capsule.title} (${capsule.status}, uses ${capsule.useCount})`);
    }
  }
  return { text: lines.join("\n") };
}

async function handleExtensionCanvasData(payload: ExtensionPayload): Promise<Record<string, unknown>> {
  const workspace = workspaceFromPayload(payload);
  if (!isWorkspaceActivated(workspace)) {
    return { active: false, workspace, model: null };
  }
  const model = await loadArcUiViewModel(workspace, { eventLimit: 12 });
  return {
    active: true,
    workspace,
    capabilities: payload.capabilities ?? {},
    model
  };
}

function normalizeExtensionEvents(payload: ExtensionPayload, sessionId: string, workspace: string): ArcEvent[] {
  const captured = Array.isArray(payload.captured) ? payload.captured.map(recordValue) : [];
  const rawEvents = captured
    .filter((item) => item.kind === "event")
    .map((item) => recordValue(item.payload))
    .filter((item) => typeof item.type === "string");
  const events = rawEvents
    .map((raw, index) => normalizeCopilotRecord(raw, index, sessionId, workspace, "copilot-sdk-extension"))
    .filter((event) => event.type !== "unknown" || (event.text ?? "").trim());

  const hasUserPrompt = events.some((event) => event.type === "user_prompt");
  const hasToolStart = events.some((event) => event.type === "tool_start");
  const hasToolEnd = events.some((event) => event.type === "tool_end");
  const hookEvents = captured.filter((item) => typeof item.kind === "string" && String(item.kind).startsWith("hook."));

  if (!hasUserPrompt) {
    for (const hook of hookEvents) {
      if (hook.kind !== "hook.userPromptSubmitted") continue;
      const prompt = stringValue(recordValue(recordValue(hook.payload).input).prompt);
      if (prompt) events.unshift(arcEvent(sessionId, workspace, "user_prompt", { id: `${sessionId}-sdk-user-prompt`, text: prompt, raw: hook }));
      break;
    }
  }
  if (!hasToolStart || !hasToolEnd) {
    for (const [index, hook] of hookEvents.entries()) {
      if (hook.kind === "hook.preToolUse" && !hasToolStart) events.push(toolHookEvent(sessionId, workspace, "tool_start", hook, index));
      if (hook.kind === "hook.postToolUse" && !hasToolEnd) events.push(toolHookEvent(sessionId, workspace, "tool_end", hook, index));
    }
  }
  if (!events.some((event) => event.type === "session_end")) {
    events.push(arcEvent(sessionId, workspace, "session_end", { id: `${sessionId}-sdk-session-end`, text: "Copilot SDK extension session ended." }));
  }
  return dedupeEvents(events);
}

function toolHookEvent(sessionId: string, workspace: string, type: "tool_start" | "tool_end", hook: JsonRecord, index: number): ArcEvent {
  const payload = recordValue(hook.payload);
  const input = recordValue(payload.input);
  const toolArgs = recordValue(input.toolArgs);
  const result = input.toolResult;
  const command = stringValue(toolArgs.command ?? toolArgs.cmd ?? toolArgs.script);
  const text = type === "tool_end" ? textValue(result) || JSON.stringify(input).slice(0, 3000) : JSON.stringify(input).slice(0, 3000);
  return arcEvent(sessionId, workspace, type, {
    id: `${sessionId}-sdk-${type}-${index}`,
    toolName: stringValue(input.toolName) || "tool",
    command,
    text,
    toolStatus: type === "tool_end" ? toolStatusFromResult(result) : "unknown",
    raw: hook
  });
}

function arcEvent(sessionId: string, workspace: string, type: ArcEvent["type"], extra: Partial<ArcEvent>): ArcEvent {
  return {
    id: extra.id ?? `${sessionId}-sdk-${type}-${Math.random().toString(36).slice(2, 10)}`,
    runner: "copilot",
    sessionId,
    workspace,
    timestamp: new Date().toISOString(),
    type,
    source: "copilot-sdk-extension",
    ...extra
  };
}

function dedupeEvents(events: ArcEvent[]): ArcEvent[] {
  const seen = new Set<string>();
  const result: ArcEvent[] = [];
  for (const event of events) {
    const key = `${event.type}\0${event.rawType ?? ""}\0${event.toolUseId ?? ""}\0${event.text ?? ""}\0${event.command ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(event);
  }
  return result;
}

function reviewOptionsFromPlans(plans: InjectionPlanSummary[]): SidecarReviewOptions {
  const injected = injectedCapsuleIds(plans);
  const last = plans.slice().reverse().find((plan) => plan.shouldInject) ?? plans.at(-1);
  return {
    injectedCapsuleIds: injected.length ? injected : undefined,
    judgeDecisionIds: judgeDecisionIds(plans),
    consultApplied: last?.consultApplied,
    consultCapsuleId: last?.consultCapsuleId,
    consultAbstainReason: last?.consultAbstainReason,
    actionRisk: last?.actionRisk
  };
}

function injectedCapsuleIds(plans: InjectionPlanSummary[] | undefined): string[] {
  return [...new Set((plans ?? []).map((plan) => plan.capsuleId).filter((id): id is string => typeof id === "string" && id.length > 0))];
}

function judgeDecisionIds(plans: InjectionPlanSummary[]): string[] | undefined {
  const ids = [...new Set(plans.map((plan) => plan.judgeDecisionId).filter((id): id is string => typeof id === "string" && id.length > 0))];
  return ids.length ? ids : undefined;
}

async function readStdinJson(): Promise<ExtensionPayload> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as ExtensionPayload;
}

function workspaceFromPayload(payload: ExtensionPayload): string {
  const input = recordValue(payload.input);
  const cwd = stringValue(input.cwd)
    || stringValue(input.workingDirectory)
    || stringValue(recordValue(payload.context).cwd)
    || stringValue(recordValue(payload.context).workingDirectory)
    || process.cwd();
  return workspaceRoot(cwd);
}

function capabilityBoolean(value: unknown, key: string): boolean {
  const capabilities = recordValue(value);
  if (typeof capabilities[key] === "boolean") return capabilities[key] as boolean;
  const ui = recordValue(capabilities.ui);
  return typeof ui[key] === "boolean" ? ui[key] as boolean : false;
}

function recordValue(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function textValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(textValue).filter(Boolean).join("\n");
  if (value && typeof value === "object") {
    const record = value as JsonRecord;
    return textValue(record.text ?? record.content ?? record.message ?? record.textResultForLlm);
  }
  return "";
}

function toolStatusFromResult(value: unknown): "success" | "failed" | "unknown" {
  const result = recordValue(value);
  if (result.resultType === "success") return "success";
  if (result.resultType === "failure" || result.resultType === "denied" || result.resultType === "rejected" || result.resultType === "timeout") return "failed";
  if (typeof result.success === "boolean") return result.success ? "success" : "failed";
  return "unknown";
}

export async function sdkExtensionPrimary(workspace: string): Promise<boolean> {
  try {
    const activation = JSON.parse(await readFile(activationPath(workspace), "utf8")) as { integration?: string };
    return activation.integration === "sdk-extension";
  } catch {
    return false;
  }
}
