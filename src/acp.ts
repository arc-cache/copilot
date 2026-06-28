import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";

import { copilotCommand } from "./copilot-command.js";
import { cleanupSidecarCopilotSessions } from "./copilot-sessions.js";
import { reviewEvents } from "./review.js";
import { recordMemoryEvent } from "./ledger.js";
import { ensureLocalEmbeddings, stopLocalEmbeddings } from "./local-embeddings.js";
import { localObserverStatus } from "./local-observer.js";
import { workspaceRoot } from "./paths.js";
import { buildInjectionPlan } from "./retrieval.js";
import { failedRunnerRejectionDetails, recordRejectionAuditRow, reviewOptionsFromPlan } from "./review-decision.js";
import { debug, saveTraceEvents } from "./store.js";
import type { ArcEvent, InjectionPlan, SidecarReviewOptions } from "./types.js";

// `arc acp` is ARC as an Agent Client Protocol middleware. Any ACP client
// connects to it as the agent; it proxies the raw NDJSON JSON-RPC stream to a
// downstream `copilot --acp` process. Only the
// messages ARC needs are intercepted:
//   - session/prompt requests get the memory injection plan prepended,
//   - session/update notifications are captured as ArcEvents,
//   - prompt responses end the turn and run the observer-gated review.
// Everything else (permissions, fs, terminals, models, modes, slash commands)
// passes through verbatim, so client and agent features keep working without
// ARC having to track the full protocol surface.

type JsonRecord = Record<string, unknown>;

interface PendingRequest {
  method: string;
  params: JsonRecord;
}

interface TurnState {
  turnNumber: number;
  turnId: string;
  sessionId: string;
  workspace: string;
  promptText: string;
  events: ArcEvent[];
  assistantText: string;
  sawAgentThought: boolean;
  toolTitles: Map<string, string>;
  openTools: Map<string, string>;
  plan: InjectionPlan | null;
}

export async function runAcpProxy(args: string[]): Promise<number> {
  const workspace = workspaceRoot();
  const launcher = downstreamCommand(args);

  // Health probe: a missing downstream CLI otherwise hangs the ACP connection
  // (broken pipes) or crashes on an unhandled spawn error. Resolve it first and
  // surface an actionable reason the host can show. The `ERROR` prefix is what
  // the app's stderr parser keys on (see acp-sessions stderr handler).
  if (!resolveDownstream(launcher.command)) {
    const hint = process.env.AGENT_RUN_CACHE_ACP_AGENT_COMMAND
      ? "Check AGENT_RUN_CACHE_ACP_AGENT_COMMAND."
      : "Install the GitHub Copilot CLI, or set AGENT_RUN_CACHE_COPILOT_BIN / AGENT_RUN_CACHE_COPILOT_COMMAND.";
    process.stderr.write(`ERROR: ARC ACP downstream agent not found: "${launcher.command}". ${hint}\n`);
    await debug("acp.downstream_missing", { command: launcher.command, label: launcher.label }, workspace);
    return 127;
  }

  const child = spawn(launcher.command, launcher.args, { stdio: ["pipe", "pipe", "pipe"] });
  child.on("error", (error) => {
    process.stderr.write(`ERROR: ARC ACP failed to launch downstream "${launcher.command}": ${error.message}\n`);
    void debug("acp.downstream_spawn_failed", { command: launcher.command, error: String(error) }, workspace).finally(() => shutdown(127));
  });
  child.stderr?.on("data", (chunk) => process.stderr.write(chunk));

  await debug("acp.started", { downstream: launcher.label, observer: localObserverStatus() }, workspace);
  void ensureLocalEmbeddings(workspace).then((info) => {
    void debug("local_embeddings.status", { state: info.state, detail: info.detail }, workspace);
  });
  // Sweep historical sidecar Copilot sessions out of `copilot --resume` (per-run
  // cleanup handles new ones; this clears junk accumulated by older builds).
  void cleanupSidecarCopilotSessions().then((removed) => {
    if (removed.length) return debug("acp.sidecar_sessions_swept", { count: removed.length }, workspace);
  }).catch(() => undefined);

  const pendingClientRequests = new Map<string, PendingRequest>();
  const sessionCwds = new Map<string, string>();
  const activeTurns = new Map<string, TurnState>();
  const turnCounters = new Map<string, number>();
  // Recent prompts per session: follow-up prompts ("did not help", "same
  // change", "what command?") carry no anchors of their own, so retrieval gets
  // the recent session context to match against.
  const sessionPrompts = new Map<string, string[]>();
  // Estimated cumulative context tokens per session, used to synthesize a
  // usage_update when the downstream agent reports none. Sessions whose
  // downstream does emit native usage opt out so we never fight a real number.
  const sessionTokens = new Map<string, number>();
  const sessionsWithNativeUsage = new Set<string>();

  const writeToAgent = (value: JsonRecord): void => {
    child.stdin?.write(`${JSON.stringify(value)}\n`);
  };
  const writeToClient = (value: JsonRecord): void => {
    process.stdout.write(`${JSON.stringify(value)}\n`);
  };

  const notifyClient = (sessionId: string, text: string): void => {
    writeToClient({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId,
        update: {
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text }
        }
      }
    });
  };

  // Client -> agent. Handled sequentially so an async injection plan cannot
  // reorder the stream.
  let clientQueue: Promise<void> = Promise.resolve();
  const clientLines = createInterface({ input: process.stdin });
  clientLines.on("line", (line) => {
    clientQueue = clientQueue.then(async () => {
      const message = parseLine(line);
      if (!message) return;
      const id = requestId(message);
      const method = typeof message.method === "string" ? message.method : "";
      if (id !== null && method) {
        const params = isRecord(message.params) ? message.params : {};
        pendingClientRequests.set(id, { method, params });
        if (method === "session/prompt") {
          await interceptPrompt(message, params);
        }
      }
      writeToAgent(message);
    }).catch(async (error) => {
      await debug("acp.client_pump_failed", { error: String(error) }, workspace);
    });
  });
  clientLines.on("close", () => {
    shutdown(0);
  });

  // Agent -> client.
  const agentLines = createInterface({ input: child.stdout! });
  agentLines.on("line", (line) => {
    const message = parseLine(line);
    if (!message) return;
    const id = requestId(message);
    const method = typeof message.method === "string" ? message.method : "";
    if (id !== null && !method && pendingClientRequests.has(id)) {
      const pending = pendingClientRequests.get(id) as PendingRequest;
      pendingClientRequests.delete(id);
      handleAgentResponse(pending, message);
    } else if (method === "session/update") {
      const updateParams = isRecord(message.params) ? message.params : {};
      noteDownstreamUsage(updateParams);
      captureUpdate(updateParams);
    }
    writeToClient(message);
  });

  async function interceptPrompt(message: JsonRecord, params: JsonRecord): Promise<void> {
    const sessionId = stringValue(params.sessionId);
    const sessionWorkspace = sessionCwds.get(sessionId) ?? workspace;
    const blocks = Array.isArray(params.prompt) ? params.prompt as JsonRecord[] : [];
    const promptText = blocks
      .filter((block) => block.type === "text" && typeof block.text === "string")
      .map((block) => String(block.text))
      .join("\n");
    const turnNumber = (turnCounters.get(sessionId) ?? 0) + 1;
    turnCounters.set(sessionId, turnNumber);
    const turnId = `${sessionId}-turn-${turnNumber}`;
    const turn: TurnState = {
      turnNumber,
      turnId,
      sessionId,
      workspace: sessionWorkspace,
      promptText,
      events: [
        arcEvent(turnId, sessionWorkspace, "session_start", { text: `ARC ACP turn started for ${sessionId}.` }),
        arcEvent(turnId, sessionWorkspace, "user_prompt", { text: promptText })
      ],
      assistantText: "",
      sawAgentThought: false,
      toolTitles: new Map(),
      openTools: new Map(),
      plan: null
    };
    activeTurns.set(sessionId, turn);

    await recordMemoryEvent({
      type: "turn.started",
      workspace: sessionWorkspace,
      sessionId,
      turnId,
      details: { prompt: promptText.slice(0, 500), runner: "copilot", surface: "acp" }
    });

    const recentPrompts = sessionPrompts.get(sessionId) ?? [];
    const plan = await safePlan(promptText, sessionWorkspace, recentPrompts);
    turn.plan = plan;
    sessionPrompts.set(sessionId, [...recentPrompts, promptText].slice(-4));
    if (plan?.shouldInject && plan.message) {
      blocks.unshift({ type: "text", text: `${plan.message}\n\nUser task follows.` });
      message.params = { ...params, prompt: blocks };
      await recordMemoryEvent({
        type: "capsule.injected",
        workspace: sessionWorkspace,
        sessionId,
        turnId,
        capsuleId: plan.capsule?.id,
        details: { source: plan.source, reason: plan.reason, title: plan.capsule?.title }
      });
      notifyClient(sessionId, `ARC memory injected: ${plan.capsule?.title ?? "capsule"}`);
    }
  }

  function handleAgentResponse(pending: PendingRequest, message: JsonRecord): void {
    const result = isRecord(message.result) ? message.result : {};
    if (pending.method === "session/new") {
      const sessionId = stringValue(result.sessionId);
      const cwd = stringValue(pending.params.cwd);
      if (sessionId) sessionCwds.set(sessionId, cwd || workspace);
      return;
    }
    if (pending.method === "session/load") {
      const sessionId = stringValue(pending.params.sessionId);
      const cwd = stringValue(pending.params.cwd);
      if (sessionId) sessionCwds.set(sessionId, cwd || workspace);
      return;
    }
    if (pending.method === "session/prompt") {
      const sessionId = stringValue(pending.params.sessionId);
      const turn = activeTurns.get(sessionId);
      if (!turn) return;
      activeTurns.delete(sessionId);
      // Synthetic closures must reach the client before the prompt response.
      closeOrphanTools(turn);
      const stopReason = stringValue(result.stopReason) || (message.error ? "error" : "unknown");
      const finalStopReason = stopReasonForTurn(turn, stopReason);
      if (finalStopReason !== stopReason) {
        message.result = { ...result, stopReason: finalStopReason };
        void debug("acp.empty_turn_detected", {
          turnId: turn.turnId,
          stopReason,
          finalStopReason,
          toolCount: turn.toolTitles.size,
          sawAgentThought: turn.sawAgentThought
        }, turn.workspace);
      }
      void finishTurn(turn, finalStopReason).catch(async (error) => {
        await debug("acp.turn_finish_failed", { error: String(error) }, turn.workspace);
      });
    }
  }

  function captureUpdate(params: JsonRecord): void {
    const sessionId = stringValue(params.sessionId);
    const turn = activeTurns.get(sessionId);
    if (!turn) return;
    const update = isRecord(params.update) ? params.update : {};
    const kind = stringValue(update.sessionUpdate);
    if (kind === "agent_message_chunk") {
      const content = isRecord(update.content) ? update.content : {};
      if (content.type === "text" && typeof content.text === "string") {
        turn.assistantText += content.text;
      }
      return;
    }
    if (kind === "agent_thought_chunk") {
      const content = isRecord(update.content) ? update.content : {};
      if (content.type === "text" && typeof content.text === "string" && content.text.trim()) {
        turn.sawAgentThought = true;
      }
      return;
    }
    if (kind === "tool_call") {
      const toolCallId = stringValue(update.toolCallId) || randomUUID();
      const title = stringValue(update.title) || stringValue(update.kind) || "tool";
      turn.toolTitles.set(toolCallId, title);
      turn.openTools.set(toolCallId, title);
      turn.events.push(arcEvent(turn.turnId, turn.workspace, "tool_start", {
        toolName: stringValue(update.kind) || "tool",
        command: title,
        path: firstLocationPath(update)
      }));
      return;
    }
    if (kind === "tool_call_update") {
      const status = stringValue(update.status);
      if (status !== "completed" && status !== "failed") return;
      const toolCallId = stringValue(update.toolCallId);
      const title = turn.toolTitles.get(toolCallId) ?? "tool";
      turn.openTools.delete(toolCallId);
      turn.events.push(arcEvent(turn.turnId, turn.workspace, "tool_end", {
        toolName: "tool",
        command: title,
        toolStatus: status === "completed" ? "success" : "failed",
        path: firstLocationPath(update)
      }));
    }
  }

  // Copilot sometimes never closes tool spans — fast tools skip the update,
  // and a user cancellation abandons whatever was running. Unclosed spans
  // leave the client UI spinning and the trace without terminal evidence, so
  // close them on both sides when the turn ends.
  function closeOrphanTools(turn: TurnState): void {
    if (!turn.openTools.size) return;
    const cancelled = /cancelled by user|canceled by user/i.test(turn.assistantText);
    for (const [toolCallId, title] of turn.openTools) {
      writeToClient({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: turn.sessionId,
          update: { sessionUpdate: "tool_call_update", toolCallId, status: cancelled ? "failed" : "completed" }
        }
      });
      turn.events.push(arcEvent(turn.turnId, turn.workspace, "tool_end", {
        toolName: "tool",
        command: title,
        toolStatus: cancelled ? "failed" : "success",
        text: cancelled ? "Synthesized: tool span was still open when the turn was cancelled." : "Synthesized: tool never reported completion before the turn ended."
      }));
    }
    void debug("acp.orphan_tools_closed", { turnId: turn.turnId, count: turn.openTools.size, cancelled }, turn.workspace);
    turn.openTools.clear();
  }

  function stopReasonForTurn(turn: TurnState, stopReason: string): string {
    const hasAssistantText = turn.assistantText.trim().length > 0;
    const hadToolActivity = turn.toolTitles.size > 0 || turn.events.some((event) => event.type === "tool_start" || event.type === "tool_end");
    if (stopReason === "end_turn" && !hasAssistantText && (hadToolActivity || turn.sawAgentThought)) {
      return "empty_turn";
    }
    return stopReason;
  }

  function noteDownstreamUsage(params: JsonRecord): void {
    const update = isRecord(params.update) ? params.update : {};
    if (stringValue(update.sessionUpdate) !== "usage_update") return;
    const sessionId = stringValue(params.sessionId);
    if (sessionId) sessionsWithNativeUsage.add(sessionId);
  }

  // The Ollama/Copilot ACP backend emits no usage, so the host context meter
  // stays blank. ARC sees the full prompt and response in the stream, so it can
  // estimate cumulative context and publish a usage_update the host renders.
  function emitUsage(turn: TurnState): void {
    if (usageDisabled() || sessionsWithNativeUsage.has(turn.sessionId)) return;
    const injected = turn.plan?.shouldInject && turn.plan.message ? turn.plan.message : "";
    const turnTokens = estimateTokens(turn.promptText) + estimateTokens(injected) + estimateTokens(turn.assistantText);
    const used = (sessionTokens.get(turn.sessionId) ?? 0) + turnTokens;
    sessionTokens.set(turn.sessionId, used);
    writeToClient({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: turn.sessionId,
        update: { sessionUpdate: "usage_update", size: contextWindowTokens(), used }
      }
    });
  }

  async function finishTurn(turn: TurnState, stopReason: string): Promise<void> {
    if (turn.assistantText) {
      turn.events.push(arcEvent(turn.turnId, turn.workspace, "assistant_message", { text: turn.assistantText }));
    }
    emitUsage(turn);
    const completed = stopReason === "end_turn";
    turn.events.push(arcEvent(turn.turnId, turn.workspace, "session_end", { text: `ARC ACP turn ${stopReason}.` }));
    await saveTraceEvents(turn.events, turn.turnId, turn.workspace);
    await recordMemoryEvent({
      type: "runner.completed",
      workspace: turn.workspace,
      sessionId: turn.sessionId,
      turnId: turn.turnId,
      details: { runner: "copilot", surface: "acp", stopReason, eventCount: turn.events.length }
    });
    if (!completed) {
      await recordRejectionAuditRow(turn.events, turn.workspace, turn.sessionId, turn.turnId, "runner did not complete", "failed", "acp-fast-path", turn.plan?.capsule?.id ? [turn.plan.capsule.id] : undefined);
      await recordMemoryEvent({
        type: "capsule.rejected",
        workspace: turn.workspace,
        sessionId: turn.sessionId,
        turnId: turn.turnId,
        details: failedRunnerRejectionDetails(turn.events, turn.plan ?? null)
      });
      return;
    }
    if (reviewDisabled()) return;
    // Automatic memory: the local observer gates inside reviewEvents and the
    // strong reviewer decides what to capsule. The client only hears about
    // actual saves, as a quiet thought-stream line.
    const reviewOptions: SidecarReviewOptions = turn.plan ? reviewOptionsFromPlan(turn.plan) : {};
    const outcome = await reviewEvents(turn.events, turn.workspace, turn.turnId, "auto", reviewOptions);
    if (outcome.status === "saved") {
      const count = outcome.capsuleIds?.length ?? 0;
      if ((turnCounters.get(turn.sessionId) ?? turn.turnNumber) !== turn.turnNumber || activeTurns.has(turn.sessionId)) {
        await debug("acp.memory_notice_suppressed", { turnId: turn.turnId, count, reason: "stale_turn" }, turn.workspace);
        return;
      }
      notifyClient(turn.sessionId, `ARC memory saved: ${count} capsule${count === 1 ? "" : "s"}.`);
    }
  }

  child.on("exit", (code) => {
    void debug("acp.downstream_exited", { code }, workspace).finally(() => shutdown(code ?? 1));
  });
  process.on("SIGTERM", () => shutdown(0));
  process.on("SIGINT", () => shutdown(0));

  let finished: ((code: number) => void) | null = null;
  function shutdown(code: number): void {
    stopLocalEmbeddings();
    child.kill("SIGTERM");
    const done = finished;
    finished = null;
    if (done) done(code);
  }

  return await new Promise<number>((resolve) => {
    finished = resolve;
  });
}

function downstreamCommand(args: string[]): { command: string; args: string[]; label: string } {
  const override = (process.env.AGENT_RUN_CACHE_ACP_AGENT_COMMAND ?? "").trim();
  if (override) {
    const [command, ...rest] = override.split(/\s+/);
    return { command, args: [...rest, ...args], label: override };
  }
  return copilotCommand(["--acp", ...args]);
}

function resolveDownstream(command: string): string | null {
  if (command.includes("/") || command.includes("\\")) return existsSync(command) ? command : null;
  const finder = process.platform === "win32" ? "where" : "which";
  const result = spawnSync(finder, [command], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  const path = result.status === 0 ? result.stdout.split(/\r?\n/)[0]?.trim() : "";
  return path || null;
}

function usageDisabled(): boolean {
  return (process.env.ARC_ACP_USAGE ?? "auto") === "off";
}

function contextWindowTokens(): number {
  const raw = Number(process.env.ARC_ACP_CONTEXT_WINDOW);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 128000;
}

// Rough char-based estimate; a context meter only needs the right order of
// magnitude. Override the divisor with ARC_ACP_CHARS_PER_TOKEN if needed.
function estimateTokens(text: string): number {
  if (!text) return 0;
  const perToken = Number(process.env.ARC_ACP_CHARS_PER_TOKEN);
  const divisor = Number.isFinite(perToken) && perToken > 0 ? perToken : 4;
  return Math.ceil(text.length / divisor);
}

function safePlan(prompt: string, workspace: string, recentPrompts: string[]): Promise<InjectionPlan | null> {
  if (!prompt.trim()) return Promise.resolve(null);
  return buildInjectionPlan(prompt, workspace, { recentPrompts, runner: "copilot" }).catch(async (error) => {
    await debug("acp.injection_failed", { error: String(error) }, workspace);
    return null;
  });
}

function reviewDisabled(): boolean {
  return (process.env.AGENT_RUN_CACHE_ACP_REVIEW ?? "auto") === "off";
}

function arcEvent(
  turnId: string,
  workspace: string,
  type: ArcEvent["type"],
  extra: Partial<ArcEvent>
): ArcEvent {
  return {
    id: `acp-${type}-${randomUUID()}`,
    runner: "copilot",
    sessionId: turnId,
    workspace,
    timestamp: new Date().toISOString(),
    type,
    source: "arc-acp",
    ...extra
  };
}

function firstLocationPath(update: JsonRecord): string | undefined {
  const locations = Array.isArray(update.locations) ? update.locations : [];
  const first = isRecord(locations[0]) ? locations[0] : null;
  const path = first ? stringValue(first.path) : "";
  return path || undefined;
}

function parseLine(line: string): JsonRecord | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function requestId(message: JsonRecord): string | null {
  const id = message.id;
  if (typeof id === "string") return id;
  if (typeof id === "number") return String(id);
  return null;
}

function isRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}
