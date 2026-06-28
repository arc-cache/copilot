import { spawn } from "node:child_process";

import { extractJsonObject } from "./json.js";
import type {
  AssembledDraft,
  Capsule,
  EvidencePacket,
  LocalObserverDecision,
  LocalObserverInput,
  LocalObserverResult,
  LocalObserverStatus,
  ObserverPacket
} from "./types.js";

const BUILTIN_MODEL = "arc-builtin-observer-v1";

// The local observer is ARC's session-local routing brain. It runs before every
// strong consult/review/observe call and returns a structured decision: handle
// locally, or ask ARC to call the configured strong provider. The default
// backend is a deterministic in-process classifier, so it is always available
// with zero setup. A command override remains for tests or local experiments,
// but ARC does not manage a generative observer model.

type ObserverMode = LocalObserverStatus["mode"];

interface ObserverRuntime {
  mode: ObserverMode;
  model: string;
  detail: string;
  command: string;
}

export function localObserverStatus(): LocalObserverStatus {
  const runtime = observerRuntime();
  return {
    enabled: runtime.mode !== "off",
    mode: runtime.mode,
    model: runtime.model,
    detail: runtime.detail
  };
}

export async function localObserverDecide(input: LocalObserverInput): Promise<LocalObserverResult | null> {
  const runtime = observerRuntime();
  if (runtime.mode === "off") return null;
  if (runtime.mode === "builtin") {
    return { decision: builtinDecide(input), source: "builtin" };
  }
  try {
    const raw = await runObserverCommand(input, runtime);
    const parsed = normalizeExternalDecision(extractJsonObject(raw) as LocalObserverDecision);
    if (!parsed || typeof parsed !== "object") throw new Error("local observer output was not a JSON object");
    return { decision: parsed, source: "command" };
  } catch (error) {
    return { decision: builtinDecide(input), source: "builtin-fallback", fallbackError: String(error) };
  }
}

function observerRuntime(): ObserverRuntime {
  const setting = envValue("LOCAL_OBSERVER", "auto").toLowerCase();
  if (setting === "off") {
    return { mode: "off", model: BUILTIN_MODEL, detail: "local observer disabled", command: "" };
  }
  const command = envValue("LOCAL_OBSERVER_COMMAND", "");
  if (setting !== "builtin" && command) {
    return { mode: "command", model: envValue("LOCAL_OBSERVER_MODEL", "external"), detail: "local observer command override", command };
  }
  return { mode: "builtin", model: BUILTIN_MODEL, detail: "built-in deterministic observer (always on)", command: "" };
}

function envValue(suffix: string, fallback: string): string {
  return (process.env[`AGENT_RUN_CACHE_${suffix}`] ?? process.env[`ARC_${suffix}`] ?? fallback).trim();
}

function observerTimeoutMs(): number {
  const value = Number(envValue("LOCAL_OBSERVER_TIMEOUT_MS", "15000"));
  return Number.isFinite(value) && value > 0 ? value : 15_000;
}

// --- external command override ---

async function runObserverCommand(input: LocalObserverInput, runtime: ObserverRuntime): Promise<string> {
  return runProcess(process.env.SHELL ?? "/bin/sh", ["-lc", runtime.command], JSON.stringify(compactInput(input)));
}

function compactInput(input: LocalObserverInput): Record<string, unknown> {
  if (input.task === "consult") {
    return {
      task: input.task,
      workspace: input.workspace,
      prompt: input.prompt,
      capsules: (input.capsules ?? []).slice(0, 8).map((capsule) => ({
        id: capsule.id,
        title: capsule.title,
        kind: capsule.kind,
        summary: capsule.summary,
        confidence: capsule.confidence,
        reuseWhen: capsule.reuseWhen.slice(0, 6),
        doNotReuseWhen: capsule.doNotReuseWhen.slice(0, 6),
        nextRunInstruction: capsule.nextRunInstruction,
        workflow: {
          purpose: capsule.workflow?.purpose,
          parameters: capsule.workflow?.parameters?.slice(0, 6),
          bindingSources: capsule.workflow?.bindingSources?.slice(0, 6),
          commands: capsule.workflow?.commands?.slice(0, 4),
          validationProbe: capsule.workflow?.validationProbe?.slice(0, 4)
        }
      }))
    };
  }
  if (input.task === "review") {
    const draft = input.packet && "packetKind" in input.packet ? input.packet : undefined;
    if (draft) {
      return {
        task: input.task,
        workspace: input.workspace,
        packet: compactDraft(draft)
      };
    }
    const packet = input.packet && "episodes" in input.packet ? input.packet : undefined;
    return {
      task: input.task,
      workspace: input.workspace,
      packet: packet
        ? {
          runner: packet.runner,
          sessionId: packet.sessionId,
          eventCount: packet.eventCount,
          outcome: packet.outcome,
          prompts: packet.prompts.slice(-3),
          assistantMessages: packet.assistantMessages.slice(-4).map((message) => truncate(message, 1200)),
          commands: packet.commands.slice(-20),
          paths: packet.paths.slice(-20),
          episodes: packet.episodes.slice(-4).map((episode) => ({
            prompt: truncate(episode.prompt, 800),
            assistantMessages: episode.assistantMessages.slice(-3).map((message) => truncate(message, 1000)),
            commands: episode.commands.slice(-12),
            paths: episode.paths.slice(-12),
            outcome: episode.outcome
          }))
        }
        : input.packet
    };
  }
  const packet = input.packet && "recentEvents" in input.packet ? input.packet : undefined;
  return {
    task: input.task,
    workspace: input.workspace,
    packet: packet
      ? {
        runner: packet.runner,
        sessionId: packet.sessionId,
        elapsedMs: packet.elapsedMs,
        eventCount: packet.eventCount,
        newEventCount: packet.newEventCount,
        prompts: packet.prompts.slice(-3),
        assistantMessages: packet.assistantMessages.slice(-4).map((message) => truncate(message, 1000)),
        commands: packet.commands.slice(-16),
        paths: packet.paths.slice(-16),
        recentEvents: packet.recentEvents.slice(-16).map((event) => ({
          type: event.type,
          source: event.source,
          text: truncate(event.text, 500),
          command: truncate(event.command, 500),
          path: event.path,
          toolStatus: event.toolStatus
        }))
      }
      : input.packet
  };
}

function compactDraft(draft: AssembledDraft): Record<string, unknown> {
  return {
    packetKind: draft.packetKind,
    runner: draft.runner,
    sessionId: draft.sessionId,
    goalId: draft.goalId,
    span: draft.span,
    goal: truncate(draft.goal, 1000),
    prompts: draft.prompts.slice(-5).map((prompt) => truncate(prompt, 800)),
    commands: draft.commands.slice(-20),
    parameters: draft.parameters.slice(0, 16),
    paths: draft.paths.slice(0, 24),
    outcome: draft.outcome,
    observations: draft.observations.slice(-6).map((observation) => ({
      status: observation.status,
      currentGoal: truncate(observation.currentGoal, 800),
      importantSignals: observation.importantSignals?.slice(0, 8),
      possibleReusableWork: observation.possibleReusableWork,
      risks: observation.risks?.slice(0, 6),
      reason: truncate(observation.reason, 500)
    }))
  };
}

function normalizeExternalDecision(decision: LocalObserverDecision): LocalObserverDecision {
  if (!decision || typeof decision !== "object") return decision;
  if (decision.shouldCallStrongModel === undefined) {
    if (decision.route === "call-strong-model") decision.shouldCallStrongModel = true;
    if (decision.route === "handled-locally") decision.shouldCallStrongModel = false;
  }
  if (!decision.consult && decision.consultChoice) {
    decision.consult = decision.consultChoice === "NONE"
      ? { applies: false, reason: decision.reason }
      : { applies: true, capsuleId: decision.consultChoice, reason: decision.reason };
  }
  if (!decision.review && decision.reviewVerdict === "not-worth-saving") {
    decision.review = { shouldSave: false, reason: decision.reason };
  }
  return decision;
}

// --- built-in deterministic classifier ---

function builtinDecide(input: LocalObserverInput): LocalObserverDecision {
  if (input.task === "consult") return builtinConsult(input.prompt ?? "", input.capsules ?? []);
  if (input.task === "review") {
    if (input.packet && "episodes" in input.packet) return builtinReview(input.packet);
    if (input.packet && "packetKind" in input.packet) return builtinReviewDraft(input.packet);
    return escalate("review packet missing");
  }
  if (input.task === "observe") {
    const packet = input.packet && "recentEvents" in input.packet ? input.packet : null;
    return packet ? builtinObserve(packet) : escalate("observer packet missing");
  }
  return escalate("unknown local observer task");
}

function escalate(reason: string): LocalObserverDecision {
  return { shouldCallStrongModel: true, providerClass: "configured", confidence: 0.2, reason };
}

function builtinConsult(prompt: string, capsules: Capsule[]): LocalObserverDecision {
  if (!prompt.trim()) {
    return {
      shouldCallStrongModel: false,
      shouldShowMemoryUi: false,
      confidence: 0.98,
      reason: "empty prompt",
      consult: { applies: false, reason: "empty prompt" }
    };
  }
  if (!capsules.length) {
    return {
      shouldCallStrongModel: false,
      shouldShowMemoryUi: false,
      confidence: 0.98,
      reason: "no saved capsules",
      consult: { applies: false, reason: "no saved capsules" }
    };
  }
  return {
    shouldCallStrongModel: true,
    shouldShowMemoryUi: false,
    providerClass: "configured",
    confidence: 0.5,
    reason: "capsule reuse requires embedding/model ranking"
  };
}

function builtinReview(packet: EvidencePacket): LocalObserverDecision {
  const commands = packet.commands.filter(Boolean);
  const prompts = packet.prompts.filter(Boolean);
  const status = packet.outcome?.status ?? "";
  const toolEvents = packet.toolEvents.filter((event) => event.type === "tool_start" || event.type === "tool_end");
  const hasToolEvidence = commands.length > 0 || toolEvents.length > 0;
  const successfulTool = toolEvents.some((event) =>
    event.type === "tool_end" && (event.toolStatus === "success" || event.exitCode === 0)
  );
  if (!prompts.join("").trim()) {
    return declineReview(0.98, "empty prompt");
  }
  if (!hasToolEvidence && packet.eventCount <= 5) {
    return declineReview(0.92, "tiny turn without tool evidence");
  }
  if (!hasToolEvidence) {
    return declineReview(0.9, "no typed tool evidence");
  }
  if (allToolEventsReadOnly(toolEvents)) {
    return declineReview(0.88, "read-only tool inspection; no reusable workflow");
  }
  if ((status === "aborted" || status === "failed") && !successfulTool) {
    return declineReview(0.88, `${status} turn without successful tool evidence`);
  }
  if (toolEvents.every((event) => event.type === "tool_start")) {
    return declineReview(0.84, "tool activity has no completed outcome");
  }
  return {
    shouldCallStrongModel: true,
    shouldShowMemoryUi: true,
    providerClass: "configured",
    confidence: 0.74,
    reason: "typed tool evidence with an outcome; call strong reviewer"
  };
}

function builtinReviewDraft(draft: AssembledDraft): LocalObserverDecision {
  if (!draft.prompts.join("").trim() && !draft.goal.trim()) {
    return declineReview(0.98, "empty draft goal");
  }
  if (!draft.commands.length) {
    return declineReview(0.9, "assembled draft has no observed commands");
  }
  if ((draft.outcome.status === "failed" || draft.outcome.status === "aborted") && !draft.outcome.successSignals.length) {
    return declineReview(0.82, `${draft.outcome.status} draft without success evidence`);
  }
  return {
    shouldCallStrongModel: true,
    shouldShowMemoryUi: true,
    providerClass: "configured",
    confidence: 0.68,
    reason: "assembled draft has observed commands; ask model prefilter or strong reviewer"
  };
}

function declineReview(confidence: number, reason: string): LocalObserverDecision {
  return {
    shouldCallStrongModel: false,
    shouldShowMemoryUi: false,
    confidence,
    reason,
    review: { shouldSave: false, reason }
  };
}

function builtinObserve(packet: ObserverPacket): LocalObserverDecision {
  const commands = packet.commands.filter(Boolean);
  const prompts = packet.prompts.filter(Boolean);
  const completedTool = packet.recentEvents.some((event) => event.type === "tool_end");
  const failedTool = packet.recentEvents.some((event) => event.type === "tool_end" && event.toolStatus === "failed");
  const possibleReusableWork = commands.length > 0 || completedTool;
  const status = failedTool ? "stuck" : completedTool ? "validating" : commands.length ? "executing" : "exploring";
  return {
    shouldCallStrongModel: false,
    shouldShowMemoryUi: false,
    confidence: 0.86,
    reason: possibleReusableWork ? "local observer sees possible reusable work" : "local observer sees no reusable work yet",
    observation: {
      status,
      currentGoal: prompts.at(-1) ?? "",
      importantSignals: commands.slice(-4),
      possibleReusableWork,
      risks: [],
      watchNext: possibleReusableWork ? ["goal close or final outcome evidence"] : ["typed tool evidence"],
      reason: possibleReusableWork ? "typed tool evidence is forming" : "no typed tool evidence yet"
    }
  };
}

function allToolEventsReadOnly(events: ObserverPacket["recentEvents"]): boolean {
  const toolEvents = events.filter((event) => event.type === "tool_start" || event.type === "tool_end");
  if (!toolEvents.length) return false;
  return toolEvents.every((event) => {
    const name = (event.toolName ?? "").toLowerCase();
    if (name === "read" || name === "read_file" || name === "search" || name === "grep" || name === "glob" || name === "list") {
      return true;
    }
    return name.includes("read") || name.includes("search");
  });
}

function truncate(value: string | undefined, limit: number): string {
  if (!value) return "";
  return value.length > limit ? `${value.slice(0, limit)}...` : value;
}

async function runProcess(command: string, args: string[], input: string): Promise<string> {
  const timeoutMs = observerTimeoutMs();
  const child = spawn(command, args, {
    cwd: process.cwd(),
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, AGENT_RUN_CACHE_IN_LOCAL_OBSERVER: "1" }
  });
  child.stdin.end(input);
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
  child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
  const code = await new Promise<number>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!child.killed) child.kill("SIGKILL");
      }, 500).unref();
      reject(new Error(`${command} ${args.join(" ")} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref();
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(exitCode ?? 0);
    });
  });
  const out = Buffer.concat(stdout).toString("utf8");
  if (code !== 0) {
    const err = Buffer.concat(stderr).toString("utf8");
    throw new Error(`${command} ${args.join(" ")} failed with ${code}\n${err.slice(-4000)}`);
  }
  return out;
}
