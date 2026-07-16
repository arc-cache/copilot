import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve } from "node:path";

import { appendJsonl, extractJsonObject } from "./json.js";
import { copilotSidecarCommand } from "./copilot-command.js";
import { cleanupSidecarCopilotSessions, listCopilotSessionIds } from "./copilot-sessions.js";
import { reviewRecurrence } from "./declined.js";
import { sidecarPath } from "./paths.js";
import { redactJson, redactSensitiveText } from "./redact.js";
import { debug, loadCapsules } from "./store.js";
import { localObserverDecide } from "./local-observer.js";
import { recordReviewerCall, reviewerBudgetReason } from "./telemetry.js";
import type {
  AssembledDraft,
  Capsule,
  EvidencePacket,
  LocalObserverDecision,
  LocalObserverInput,
  ObserverJudgment,
  ObserverPacket,
  Runner,
  ReviewIntent,
  ReviewPacket,
  SidecarReviewOptions,
  SidecarConsult,
  SidecarReview
} from "./types.js";

type ModelSidecarRunner = "opencode" | "copilot";
type ModelSidecarSetting = "auto" | "off" | ModelSidecarRunner;
type JudgeModelSelection = { provider: "copilot" | "ollama"; id: string };

export async function reviewPacket(
  packet: ReviewPacket,
  workspace: string,
  intent: ReviewIntent = "auto",
  options: SidecarReviewOptions = {}
): Promise<SidecarReview | null> {
  const reviewInput = strongReviewInput(packet, intent);
  const recurrence = options.recurrence ?? await reviewRecurrence(
    isAssembledDraft(reviewInput) ? reviewInput.mergeKey : draftMergeKeyFromEvidence(packet as EvidencePacket),
    packet.sessionId,
    workspace
  );
  // A user-requested save is an explicit decision; the observer gate only
  // filters reviews ARC initiates on its own.
  if (intent === "auto" && !recurrence) {
    const gated = await reviewGateFromObserver(packet, workspace);
    if (gated) return gated;
  }
  const existingCapsules = await reviewCandidateCapsules(packet, workspace, options);
  const reviewContext = reviewContextFromOptions({ ...options, recurrence });
  const command = process.env.AGENT_RUN_CACHE_REVIEWER_COMMAND;
  if (command) {
    const input = JSON.stringify(reviewContext ? { ...reviewInput, reviewContext } : reviewInput);
    const blocked = await reviewerBudgetReason(workspace, packet.sessionId);
    if (blocked) return { shouldSave: false, reason: blocked };
    const started = Date.now();
    let output: string;
    try {
      output = await runShellCommand(command, input);
      await recordReviewerCall({ workspace, sessionId: packet.sessionId, source: "command", durationMs: Date.now() - started, status: "success", input, output });
    } catch (error) {
      await recordReviewerCall({ workspace, sessionId: packet.sessionId, source: "command", durationMs: Date.now() - started, status: "failed", input, output: "", reason: "reviewer call failed" });
      throw error;
    }
    const parsed = parseReview(output);
    await recordSidecarExchange(workspace, "review", "command", input, output, parsed);
    await debug("sidecar.review.command", { bytes: output.length }, workspace);
    return parsed;
  }
  const prompt = reviewPrompt(reviewInput, existingCapsules, reviewContext);
  if (options.reviewer) {
    const blocked = await reviewerBudgetReason(workspace, packet.sessionId);
    if (blocked) return { shouldSave: false, reason: blocked };
    const started = Date.now();
    let parsed: SidecarReview | null;
    try {
      parsed = await options.reviewer({
        runner: reviewInput.runner,
        intent,
        packet: reviewInput,
        prompt,
        existingCapsules,
        reviewContext
      });
      await recordReviewerCall({ workspace, sessionId: packet.sessionId, source: "callback", durationMs: Date.now() - started, status: "success", input: prompt, output: JSON.stringify(parsed ?? null) });
    } catch (error) {
      await recordReviewerCall({ workspace, sessionId: packet.sessionId, source: "callback", durationMs: Date.now() - started, status: "failed", input: prompt, output: "", reason: "reviewer call failed" });
      throw error;
    }
    const output = JSON.stringify(parsed ?? null);
    await recordSidecarExchange(workspace, "review", reviewInput.runner, prompt, output, parsed);
    await debug(`sidecar.review.${reviewInput.runner}`, { bytes: output.length, source: "callback" }, workspace);
    return parsed;
  }
  if (process.env.AGENT_RUN_CACHE_MODEL_SIDECAR === "off") {
    await debug("sidecar.review.skipped", { reason: "AGENT_RUN_CACHE_MODEL_SIDECAR=off" }, workspace);
    return null;
  }
  const runner = sidecarRunnerFor(packet.runner);
  if (!runner) {
    const reason = sidecarUnavailableReason("review", packet.runner);
    await debug("sidecar.review.skipped", {
      reason,
      packetRunner: packet.runner,
      modelSidecar: process.env.AGENT_RUN_CACHE_MODEL_SIDECAR ?? "auto"
    }, workspace);
    return { shouldSave: false, reason };
  }
  const blocked = await reviewerBudgetReason(workspace, packet.sessionId);
  if (blocked) return { shouldSave: false, reason: blocked };
  const started = Date.now();
  let output: string;
  try {
    output = await runModelSidecar(prompt, workspace, runner);
    await recordReviewerCall({ workspace, sessionId: packet.sessionId, source: runner, durationMs: Date.now() - started, status: "success", input: prompt, output });
  } catch (error) {
    await recordReviewerCall({ workspace, sessionId: packet.sessionId, source: runner, durationMs: Date.now() - started, status: "failed", input: prompt, output: "", reason: "reviewer call failed" });
    throw error;
  }
  const parsed = parseReview(output);
  await recordSidecarExchange(workspace, "review", runner, prompt, output, parsed);
  await debug(`sidecar.review.${runner}`, { bytes: output.length }, workspace);
  return parsed;
}

type ReviewContext = Pick<SidecarReviewOptions, "consultApplied" | "consultCapsuleId" | "consultAbstainReason" | "actionRisk" | "injectedCapsuleIds" | "judgeDecisionIds" | "recurrence">;

function reviewContextFromOptions(options: SidecarReviewOptions): ReviewContext | undefined {
  const context: ReviewContext = {
    consultApplied: options.consultApplied,
    consultCapsuleId: options.consultCapsuleId,
    consultAbstainReason: options.consultAbstainReason,
    actionRisk: options.actionRisk,
    injectedCapsuleIds: options.injectedCapsuleIds,
    judgeDecisionIds: options.judgeDecisionIds,
    recurrence: options.recurrence
  };
  return Object.values(context).some((value) => value !== undefined) ? context : undefined;
}

export async function consultCapsuleVault(
  prompt: string,
  capsules: Capsule[],
  workspace: string,
  context: { runner?: Runner; judgeModel?: JudgeModelSelection } = {}
): Promise<SidecarConsult | null> {
  if (!capsules.length) return null;
  const gate = await consultGateFromObserver(prompt, capsules, workspace);
  if (gate.handled) return gate.consult;
  const consultCapsules = compactConsultCapsules(capsules);
  const command = process.env.AGENT_RUN_CACHE_CONSULT_COMMAND;
  if (command) {
    const input = JSON.stringify({ prompt, capsules: consultCapsules });
    const output = await runShellCommand(command, input);
    const parsed = parseConsult(output);
    await recordSidecarExchange(workspace, "consult", "command", input, output, parsed);
    await debug("sidecar.consult.command", { bytes: output.length, candidateCount: capsules.length }, workspace);
    return parsed;
  }
  if (process.env.AGENT_RUN_CACHE_MODEL_SIDECAR === "off" && !context.judgeModel) {
    await debug("sidecar.consult.skipped", { reason: "AGENT_RUN_CACHE_MODEL_SIDECAR=off", candidateCount: capsules.length }, workspace);
    return null;
  }
  const runner = context.judgeModel?.provider === "copilot" ? "copilot" : sidecarRunnerFor(context.runner);
  if (!runner && context.judgeModel?.provider !== "ollama") {
    await debug("sidecar.consult.skipped", {
      reason: sidecarUnavailableReason("consult", context.runner),
      packetRunner: context.runner ?? "unknown",
      modelSidecar: process.env.AGENT_RUN_CACHE_MODEL_SIDECAR ?? "auto",
      candidateCount: capsules.length
    }, workspace);
    return null;
  }
  const sidecarPrompt = consultPrompt(prompt, consultCapsules);
  const output = await runJudgeSidecar(sidecarPrompt, workspace, runner ?? "copilot", context.judgeModel);
  const parsed = parseConsult(output);
  const source = context.judgeModel?.provider ?? runner ?? "copilot";
  await recordSidecarExchange(workspace, "consult", source, sidecarPrompt, output, parsed);
  await debug(`sidecar.consult.${source}`, {
    bytes: output.length,
    candidateCount: capsules.length,
    model: context.judgeModel?.id
  }, workspace);
  return parsed;
}

export async function observePacket(packet: ObserverPacket, workspace: string): Promise<ObserverJudgment | null> {
  const gate = await observeGateFromObserver(packet, workspace);
  if (gate.handled) return gate.observation;
  const command = process.env.AGENT_RUN_CACHE_OBSERVER_COMMAND;
  if (command) {
    const input = JSON.stringify(packet);
    const output = await runShellCommand(command, input);
    const parsed = parseObservation(output);
    await recordSidecarExchange(workspace, "observe", "command", input, output, parsed);
    await debug("sidecar.observe.command", { bytes: output.length, eventCount: packet.eventCount }, workspace);
    return parsed;
  }
  if (process.env.AGENT_RUN_CACHE_MODEL_SIDECAR === "off") {
    await debug("sidecar.observe.skipped", { reason: "AGENT_RUN_CACHE_MODEL_SIDECAR=off", eventCount: packet.eventCount }, workspace);
    return null;
  }
  const runner = sidecarRunnerFor(packet.runner);
  if (!runner) {
    await debug("sidecar.observe.skipped", {
      reason: sidecarUnavailableReason("observe", packet.runner),
      packetRunner: packet.runner,
      modelSidecar: process.env.AGENT_RUN_CACHE_MODEL_SIDECAR ?? "auto",
      eventCount: packet.eventCount
    }, workspace);
    return null;
  }
  const prompt = observePrompt(packet);
  const output = await runModelSidecar(prompt, workspace, runner);
  const parsed = parseObservation(output);
  await recordSidecarExchange(workspace, "observe", runner, prompt, output, parsed);
  await debug(`sidecar.observe.${runner}`, { bytes: output.length, eventCount: packet.eventCount }, workspace);
  return parsed;
}

async function reviewGateFromObserver(packet: ReviewPacket, workspace: string): Promise<SidecarReview | null> {
  const decision = await safeObserverDecision({ task: "review", workspace, packet }, workspace);
  if (!decision) return null;
  if (decision.shouldCallStrongModel === false) {
    const review = decision.review?.shouldSave === false
      ? decision.review
      : { shouldSave: false, reason: decision.reason ?? "local observer found no durable reusable memory" };
    await debug("local_observer.review_declined", {
      reason: review.reason,
      confidence: decision.confidence,
      showMemoryUi: decision.shouldShowMemoryUi
    }, workspace);
    return review;
  }
  await debug("local_observer.review_escalated", {
    reason: decision.reason,
    confidence: decision.confidence,
    providerClass: decision.providerClass
  }, workspace);
  return null;
}

async function consultGateFromObserver(
  prompt: string,
  capsules: Capsule[],
  workspace: string
): Promise<{ handled: boolean; consult: SidecarConsult | null }> {
  const decision = await safeObserverDecision({ task: "consult", workspace, prompt, capsules: capsules.slice(0, 8) }, workspace);
  if (!decision) return { handled: false, consult: null };
  const consult = decision.consult;
  if (decision.shouldCallStrongModel === false && consult?.applies && confidenceAtLeast(decision, 0.82)) {
    await debug("local_observer.consult_selected", {
      capsuleId: consult.capsuleId,
      reason: consult.reason,
      confidence: decision.confidence
    }, workspace);
    return { handled: true, consult };
  }
  if (decision.shouldCallStrongModel === false) {
    const result = consult ?? { applies: false, reason: decision.reason ?? "local observer found no matching capsule" };
    await debug("local_observer.consult_declined", {
      applies: result.applies,
      reason: result.reason,
      confidence: decision.confidence
    }, workspace);
    return { handled: true, consult: result };
  }
  await debug("local_observer.consult_escalated", {
    reason: decision.reason,
    confidence: decision.confidence,
    providerClass: decision.providerClass,
    candidateCount: capsules.length
  }, workspace);
  return { handled: false, consult: null };
}

async function observeGateFromObserver(
  packet: ObserverPacket,
  workspace: string
): Promise<{ handled: boolean; observation: ObserverJudgment | null }> {
  const decision = await safeObserverDecision({ task: "observe", workspace, packet }, workspace);
  if (!decision) return { handled: false, observation: null };
  if (decision.observation) {
    await debug("local_observer.observation", {
      status: decision.observation.status,
      possibleReusableWork: decision.observation.possibleReusableWork,
      reason: decision.observation.reason ?? decision.reason,
      confidence: decision.confidence
    }, workspace);
    return { handled: true, observation: decision.observation };
  }
  if (decision.shouldCallStrongModel === false) {
    await debug("local_observer.observe_declined", {
      reason: decision.reason,
      confidence: decision.confidence
    }, workspace);
    return { handled: true, observation: null };
  }
  await debug("local_observer.observe_escalated", {
    reason: decision.reason,
    confidence: decision.confidence,
    providerClass: decision.providerClass
  }, workspace);
  return { handled: false, observation: null };
}

async function safeObserverDecision(
  input: LocalObserverInput,
  workspace: string
): Promise<LocalObserverDecision | null> {
  try {
    const result = await localObserverDecide(input);
    if (!result) return null;
    if (result.fallbackError) {
      await debug("local_observer.fallback", { task: input.task, error: result.fallbackError }, workspace);
    }
    await debug("local_observer.decision", {
      task: input.task,
      source: result.source,
      shouldCallStrongModel: result.decision.shouldCallStrongModel,
      shouldShowMemoryUi: result.decision.shouldShowMemoryUi,
      confidence: result.decision.confidence,
      reason: result.decision.reason,
      providerClass: result.decision.providerClass
    }, workspace);
    return result.decision;
  } catch (error) {
    await debug("local_observer.failed", { task: input.task, error: String(error) }, workspace);
    return null;
  }
}

function confidenceAtLeast(decision: LocalObserverDecision, threshold: number): boolean {
  return typeof decision.confidence === "number" && decision.confidence >= threshold;
}

function parseConsult(output: string): SidecarConsult {
  const parsed = extractJsonObject(output) as SidecarConsult;
  if (!parsed || typeof parsed !== "object") throw new Error("Sidecar consult was not an object.");
  return parsed;
}

function parseReview(output: string): SidecarReview {
  const parsed = extractJsonObject(output) as SidecarReview;
  if (!parsed || typeof parsed !== "object") throw new Error("Sidecar review was not an object.");
  return parsed;
}

function parseObservation(output: string): ObserverJudgment {
  const parsed = extractJsonObject(output) as ObserverJudgment;
  if (!parsed || typeof parsed !== "object") throw new Error("Sidecar observation was not an object.");
  return parsed;
}

function compactConsultCapsules(capsules: Capsule[]): Record<string, unknown>[] {
  return capsules.slice(0, 30).map((capsule) => ({
    id: capsule.id,
    kind: capsule.kind,
    title: truncateForSidecar(capsule.title, 200),
    summary: truncateForSidecar(capsule.summary, 900),
    confidence: capsule.confidence,
    reuseWhen: truncateListForSidecar(capsule.reuseWhen, 8, 220),
    doNotReuseWhen: truncateListForSidecar(capsule.doNotReuseWhen, 8, 220),
    artifactSources: truncateListForSidecar(capsule.artifactSources, 8, 180),
    provenance: truncateListForSidecar(capsule.provenance, 8, 180),
    failureBoundary: truncateListForSidecar(capsule.failureBoundary, 6, 260),
    outcomeStatus: capsule.outcomeStatus,
    nextRunInstruction: truncateForSidecar(capsule.nextRunInstruction, 1000),
    staleness: capsule.staleness
      ? {
        stale: capsule.staleness.stale,
        reasons: truncateListForSidecar(capsule.staleness.reasons, 6, 220)
      }
      : undefined,
    workflow: {
      purpose: truncateForSidecar(capsule.workflow?.purpose, 600),
      parameters: truncateListForSidecar(capsule.workflow?.parameters, 8, 180),
      bindingSources: truncateListForSidecar(capsule.workflow?.bindingSources, 10, 180),
      steps: truncateListForSidecar(capsule.workflow?.steps, 10, 280),
      commands: truncateListForSidecar(capsule.workflow?.commands, 6, 600),
      successCriteria: truncateListForSidecar(capsule.workflow?.successCriteria, 6, 220),
      failedAttempts: truncateListForSidecar(capsule.workflow?.failedAttempts, 6, 220),
      validationProbe: truncateListForSidecar(capsule.workflow?.validationProbe, 6, 220)
    }
  }));
}

function truncateListForSidecar(values: string[] | undefined, count: number, itemLimit: number): string[] {
  return (values ?? []).slice(0, count).map((value) => truncateForSidecar(value, itemLimit)).filter(Boolean);
}

function truncateForSidecar(value: string | undefined, limit: number): string {
  if (!value) return "";
  return value.length > limit ? `${value.slice(0, Math.max(0, limit - 3)).trimEnd()}...` : value;
}

function consultPrompt(prompt: string, capsules: Record<string, unknown>[]): string {
  return `You are the Agent Run Cache consulting sidecar.

The main agent is about to handle a user prompt in this repository. Decide whether any saved workflow capsule from this repo is close enough to help.

Return JSON only:
{
  "applies": true,
  "capsuleId": "id from the vault",
  "confidence": 0.0,
  "reason": "why this applies",
  "note": "compact note to give the main agent"
}

If nothing clearly applies, return {"applies": false, "confidence": 0.0, "reason": "..."}.

Rules:
- You decide semantic similarity. Do not require exact words.
- Prefer one strong capsule over many weak ones.
- Do not use provenance-only files as required inputs unless the capsule lists them as binding sources.
- If a prior user-supplied runbook/script taught a method, prefer the extracted method and current binding sources over requiring the original runbook/script.
- The note should tell the main agent what prior workflow may matter, what to verify first, and whether a reusable command/script shape was captured.
- If the capsule has command/script shapes, tell the main agent to reuse them with fresh parameters.
- If the capsule has no command/script shapes, tell the main agent not to invent one from memory; it should verify the binding source and answer or ask before optional execution.
- Return applies:false when the user explicitly forbids the capsule's action, even if the capsule is otherwise related.
- For pasted command output, logs, or diagnostic transcripts, do not apply action capsules merely because they could gather more data. Apply only when the user asks the agent to execute, inspect live state, or the capsule directly answers the prompt.
- Stay silent if the prompt is unrelated.

User prompt:
${prompt}

Capsule vault:
${JSON.stringify(capsules.slice(0, 30)).slice(0, 60000)}`;
}

async function reviewCandidateCapsules(
  packet: ReviewPacket,
  workspace: string,
  options: SidecarReviewOptions
): Promise<Capsule[]> {
  const capsules = await loadCapsules(workspace);
  if (!capsules.length) return [];

  const injected = new Set((options.injectedCapsuleIds ?? []).filter(Boolean));
  const query = reviewCandidateText(packet);
  const queryTokens = reviewCandidateTokens(query);
  const scored = capsules
    .map((capsule, index) => ({
      capsule,
      index,
      score: injected.has(capsule.id) ? 100 : candidateScore(capsule, queryTokens)
    }))
    .filter((entry) => entry.score > 0.18 || injected.has(entry.capsule.id))
    .sort((left, right) => right.score - left.score || left.index - right.index);

  const candidates = scored.slice(0, 5).map((entry) => entry.capsule);
  if (candidates.length) {
    await debug("sidecar.review_candidates", {
      count: candidates.length,
      injected: candidates.filter((capsule) => injected.has(capsule.id)).map((capsule) => capsule.id)
    }, workspace);
  }
  return candidates;
}

function reviewCandidateText(packet: ReviewPacket): string {
  if (isAssembledDraft(packet)) {
    return [
      packet.goal,
      packet.prompts.join(" "),
      packet.commands.join(" "),
      packet.parameters.join(" "),
      packet.paths.join(" "),
      (packet.evidenceSnippets ?? []).join(" ")
    ].join(" ");
  }
  return [
    packet.prompts.join(" "),
    packet.assistantMessages.join(" "),
    packet.commands.join(" "),
    packet.paths.join(" "),
    packet.episodes.map((episode) => [
      episode.prompt,
      episode.assistantMessages.join(" "),
      episode.commands.join(" "),
      episode.paths.join(" ")
    ].join(" ")).join(" ")
  ].join(" ");
}

function candidateScore(capsule: Capsule, queryTokens: Set<string>): number {
  if (!queryTokens.size) return 0;
  const capsuleTokens = reviewCandidateTokens([
    capsule.kind,
    capsule.mergeKey,
    capsule.title,
    capsule.summary,
    capsule.nextRunInstruction,
    capsule.reuseWhen.join(" "),
    capsule.workflow.purpose,
    capsule.workflow.parameters.join(" "),
    capsule.workflow.bindingSources.join(" "),
    capsule.workflow.steps.join(" "),
    capsule.workflow.commands.join(" "),
    capsule.workflow.failedAttempts.join(" "),
    capsule.workflow.validationProbe.join(" ")
  ].join(" "));
  if (!capsuleTokens.size) return 0;
  let hits = 0;
  for (const token of capsuleTokens) {
    if (queryTokens.has(token)) hits += 1;
  }
  return hits / Math.min(capsuleTokens.size, queryTokens.size);
}

function reviewCandidateTokens(value: string): Set<string> {
  const generic = new Set([
    "and", "are", "ask", "before", "binding", "bindings", "capsule", "check", "command", "commands", "config",
    "configuration", "current", "file", "files", "from", "future", "into", "local", "method", "next", "path",
    "probe", "prompt", "resolve", "resolved", "reusable", "run", "session", "source", "sources", "step", "steps",
    "target", "test", "testing", "that", "the", "this", "through", "use", "used", "user", "values", "verify",
    "workflow"
  ]);
  const tokens = value
    .toLowerCase()
    .split(/[^a-z0-9_./:-]+/)
    .flatMap((part) => {
      const clean = part.replace(/^[^a-z0-9_]+|[^a-z0-9_]+$/g, "");
      if (!clean) return [];
      const parts = [clean];
      const basename = clean.split("/").filter(Boolean).at(-1);
      if (basename && basename !== clean) parts.push(basename);
      parts.push(...clean.split(/[./:-]+/));
      return parts;
    })
    .map((token) => {
      if (token === "userknownhostsfile") return "known_hosts";
      return token;
    })
    .filter((token) => token.length >= 3 && !generic.has(token) && !/^\d+$/.test(token));
  return new Set(tokens);
}

function existingCapsuleContext(capsules: Capsule[]): string {
  if (!capsules.length) return "";
  const compact = capsules.map((capsule) => ({
    id: capsule.id,
    title: capsule.title,
    kind: capsule.kind,
    mergeKey: capsule.mergeKey,
    summary: capsule.summary,
    nextRunInstruction: capsule.nextRunInstruction,
    bindingSources: capsule.workflow.bindingSources,
    commandShapes: capsule.workflow.commands.slice(0, 3),
    failedAttempts: capsule.workflow.failedAttempts.slice(0, 4),
    failureBoundary: capsule.failureBoundary.slice(0, 4)
  }));
  return `

Existing capsule candidates from this workspace:
${JSON.stringify(compact).slice(0, 12000)}

Candidate rules:
- If the completed session mainly reused, validated, or slightly refined one of these candidates, do not mint a parallel capsule with a new mergeKey.
- If nothing materially new was learned beyond confirming an existing capsule still works, return {"shouldSave": false, "reason": "validated existing capsule"}.
- If a useful correction or stronger command shape was learned, emit one capsule for the same workflow and reuse the existing candidate's mergeKey when it is the same method.
- Use supersedes only when the new capsule should retire a weaker or wrong route; for a normal refinement, prefer the same mergeKey so storage updates the existing capsule.`;
}

function reviewPrompt(packet: ReviewPacket, existingCapsules: Capsule[] = [], reviewContext?: ReviewContext): string {
  if (isAssembledDraft(packet)) return assembledDraftReviewPrompt(packet, existingCapsules, reviewContext);
  const contextBlock = reviewContextPromptBlock(reviewContext);
  return `You are the Agent Run Cache sidecar.

Your job is to decide whether a completed coding-agent session produced one or more reusable workflow capsules.
Return JSON only. Do not include Markdown.

Rules:
- Save only if the session shows a reusable method, route, script, command sequence, resolver, or project fact that would help a future similar session.
- Use packet.outcome. A partial, failed, or aborted session must not become a positive workflow. For these outcomes, save only project facts, cautions, or dead ends.
- For partial, failed, or aborted work, prefer salvaging a concrete caution, dead end, or project fact when the evidence supports one. Decline only when nothing in the evidence could help a future similar session.
- Never cite a failed tool/read as positive evidence, provenance, reusable command, validation proof, or successful binding source. Failed reads belong in failureBoundary or workflow.failedAttempts, unless the capsule is explicitly about the missing/failed artifact.
- The capsule must stand alone. If the user supplied a markdown/runbook/script file, treat that file as provenance; infer the reusable method so a teammate without the file can still benefit.
- Provide a stable mergeKey for the reusable method. The same method with different targets, files, branches, or commands should reuse the same mergeKey when the workflow shape is the same.
- Use artifactSources for user-supplied runbooks/scripts whose extracted content may be useful later. Use workflow.bindingSources only for current files/configs/tools that must be verified fresh.
- Use repository-relative paths for bindingSources, provenance, artifactSources, validation probes, and instructions when a path is inside the current workspace.
- Do not copy secrets. If a command contains credentials, describe the parameter instead.
- Do not copy private IPs, MAC addresses, token values, personal home paths, or full remote URLs. Use stable placeholders such as <private-ip>, <mac-address>, <token>, <home>, and <url>.
- Do not merge unrelated work. If the packet contains distinct useful episodes, return multiple capsules. If it contains one useful method, return one capsule.
- If the session corrected an earlier bad route, set supersedes or failureBoundary so retrieval can prefer the corrected route and avoid the dead end.
- Fill validationProvenance with how the work was checked: local test, syntax only, CI image, remote health check, manual SSH verification, not verified, or similar.
- For SSH, SCP, rsync, Docker, or other remote-operation workflows, capture bounded noninteractive probes and timeouts when the evidence supports them. Treat password prompts, hung commands, transient refused connections, and shell quoting failures as failedAttempts or failureBoundary evidence.
- Code outside you will only validate JSON, store it, and budget context. You own the semantic decision.

Return this JSON shape:
{
  "shouldSave": true,
  "capsules": [
    {
      "title": "short title",
      "kind": "workflow | command | project_fact | runbook",
      "mergeKey": "stable workflow identity, not a one-off target name",
      "summary": "what was learned",
      "reusable": true,
      "confidence": 0.0,
      "reuseWhen": ["when future prompt/context matches"],
      "doNotReuseWhen": ["when it should stay silent"],
      "evidence": ["concrete proof from the trace"],
      "provenance": ["files or artifacts that informed the workflow"],
      "artifactSources": ["source files/runbooks/scripts whose useful content was extracted, if any"],
      "supersedes": ["ids or stable names of weaker/failed capsules this replaces, if known"],
      "confidenceReason": "why the confidence score is justified",
      "failureBoundary": ["where this should not be generalized or which failure it avoids"],
      "validationProvenance": ["how the trace verified the result"],
      "outcomeStatus": "success | partial | failed | aborted | unknown",
      "nextRunInstruction": "compact instruction to give the next agent first",
      "workflow": {
        "purpose": "what this workflow accomplishes",
        "parameters": ["values to resolve fresh next time"],
        "bindingSources": ["files/configs/tools to inspect fresh if needed"],
        "steps": ["ordered reusable steps"],
        "commands": ["reusable command shapes with placeholders if needed"],
        "successCriteria": ["how to know it worked"],
        "failedAttempts": ["dead ends to avoid"],
        "validationProbe": ["smallest cheap check before reuse"]
      }
    }
  ],
  "capsule": {
    "title": "short title",
    "kind": "workflow | command | project_fact | runbook",
    "mergeKey": "stable workflow identity, not a one-off target name",
    "summary": "what was learned",
    "reusable": true,
    "confidence": 0.0,
    "reuseWhen": ["when future prompt/context matches"],
    "doNotReuseWhen": ["when it should stay silent"],
    "evidence": ["concrete proof from the trace"],
    "provenance": ["files or artifacts that informed the workflow"],
    "artifactSources": ["source files/runbooks/scripts whose useful content was extracted, if any"],
    "supersedes": ["ids or stable names of weaker/failed capsules this replaces, if known"],
    "confidenceReason": "why the confidence score is justified",
    "failureBoundary": ["where this should not be generalized or which failure it avoids"],
    "validationProvenance": ["how the trace verified the result"],
    "outcomeStatus": "success | partial | failed | aborted | unknown",
    "nextRunInstruction": "compact instruction to give the next agent first",
    "workflow": {
      "purpose": "what this workflow accomplishes",
      "parameters": ["values to resolve fresh next time"],
      "bindingSources": ["files/configs/tools to inspect fresh if needed"],
      "steps": ["ordered reusable steps"],
      "commands": ["reusable command shapes with placeholders if needed"],
      "successCriteria": ["how to know it worked"],
      "failedAttempts": ["dead ends to avoid"],
      "validationProbe": ["smallest cheap check before reuse"]
    }
  }
}

Use "capsules" for new output. "capsule" is accepted only for backward compatibility.
If nothing durable was learned, return {"shouldSave": false, "reason": "..."}.
${existingCapsuleContext(existingCapsules)}
${contextBlock}

Evidence packet:
${JSON.stringify(packet).slice(0, 60000)}`;
}

function reviewContextPromptBlock(reviewContext?: ReviewContext): string {
  if (!reviewContext) return "";
  let block = `\nARC review context from pre-turn retrieval:\n${JSON.stringify(reviewContext).slice(0, 2000)}\nIf actionRisk is present, do not save a broad live-action capsule from this turn. Save only a narrow interpretation, caution, or project fact unless the trace also shows explicit live-action intent and successful validation.\n`;
  if (reviewContext.recurrence) {
    block += `This method has been observed ${reviewContext.recurrence.recurrenceCount} times across sessions (previously declined: ${reviewContext.recurrence.priorDeclineReason.slice(0, 500)}). Recurrence is evidence of reusability; prefer saving with provenance noting both sessions. You still own the save or decline decision.\n`;
  }
  return block;
}

function assembledDraftReviewPrompt(
  packet: AssembledDraft,
  existingCapsules: Capsule[] = [],
  reviewContext?: ReviewContext
): string {
  return `You are the Agent Run Cache sidecar.

ARC's local loop assembled this draft at a goal boundary. The draft is not a capsule and it is not authoritative prose; it is a compact evidence object made from typed events and local observations.

Your job is to decide whether the completed goal produced one or more reusable workflow capsules.
Return JSON only. Do not include Markdown.

Rules:
- Save only if the draft shows a reusable method, route, command shape, resolver, project fact, caution, or dead end that would help a future similar session.
- The local loop is not allowed to author capsules. You own the durable save/decline and capsule prose.
- Treat commands as verbatim observed commands. Do not invent commands, paths, tools, or validation that are not present in the draft.
- Use packet.outcome. A partial, failed, or aborted goal must not become a positive workflow. For these outcomes, save only project facts, cautions, or dead ends.
- For partial, failed, or aborted work, prefer salvaging a concrete caution, dead end, or project fact when the evidence supports one. Decline only when nothing in the evidence could help a future similar session.
- Never cite a failed tool/read as positive evidence, provenance, reusable command, validation proof, or successful binding source. Failed reads belong in failureBoundary or workflow.failedAttempts, unless the capsule is explicitly about the missing/failed artifact.
- The capsule must stand alone. If the user supplied a markdown/runbook/script file, treat that file as provenance; infer the reusable method so a teammate without the file can still benefit.
- Provide a stable mergeKey for the reusable method. The same method with different targets, files, branches, or commands should reuse the same mergeKey when the workflow shape is the same.
- Prefer extending or superseding an existing workflow over minting a parallel project_fact that restates the same method.
- Use artifactSources for user-supplied runbooks/scripts whose extracted content may be useful later. Use workflow.bindingSources only for current files/configs/tools that must be verified fresh.
- Use repository-relative paths for bindingSources, provenance, artifactSources, validation probes, and instructions when a path is inside the current workspace.
- Do not copy secrets. If a command contains credentials, describe the parameter instead.
- Do not copy private IPs, MAC addresses, token values, personal home paths, or full remote URLs. Use stable placeholders such as <private-ip>, <mac-address>, <token>, <home>, and <url>.
- If nothing durable was learned, return {"shouldSave": false, "reason": "..."}.
${existingCapsuleContext(existingCapsules)}
${reviewContextPromptBlock(reviewContext)}

Return the same JSON shape as normal ARC reviews:
{
  "shouldSave": true,
  "capsules": [
    {
      "title": "short title",
      "kind": "workflow | command | project_fact | runbook",
      "mergeKey": "stable workflow identity, not a one-off target name",
      "summary": "what was learned",
      "reusable": true,
      "confidence": 0.0,
      "reuseWhen": ["when future prompt/context matches"],
      "doNotReuseWhen": ["when it should stay silent"],
      "evidence": ["concrete proof from the trace"],
      "provenance": ["files or artifacts that informed the workflow"],
      "artifactSources": ["source files/runbooks/scripts whose useful content was extracted, if any"],
      "supersedes": ["ids or stable names of weaker/failed capsules this replaces, if known"],
      "confidenceReason": "why the confidence score is justified",
      "failureBoundary": ["where this should not be generalized or which failure it avoids"],
      "validationProvenance": ["how the trace verified the result"],
      "outcomeStatus": "success | partial | failed | aborted | unknown",
      "nextRunInstruction": "compact instruction to give the next agent first",
      "workflow": {
        "purpose": "what this workflow accomplishes",
        "parameters": ["values to resolve fresh next time"],
        "bindingSources": ["files/configs/tools to inspect fresh if needed"],
        "steps": ["ordered reusable steps"],
        "commands": ["reusable command shapes with placeholders if needed"],
        "successCriteria": ["how to know it worked"],
        "failedAttempts": ["dead ends to avoid"],
        "validationProbe": ["smallest cheap check before reuse"]
      }
    }
  ]
}

Assembled draft:
${JSON.stringify(packet).slice(0, 40000)}`;
}

function observePrompt(packet: ObserverPacket): string {
  return `You are the live Agent Run Cache observer sidecar.

The main Copilot session is still running. You are not controlling it and you are not saving durable memory yet.
Your job is to watch the visible transcript/tool evidence and explain what appears to be happening.

Return JSON only:
{
  "status": "starting | exploring | executing | validating | stuck | likely_done",
  "currentGoal": "what the main agent seems to be trying to do",
  "importantSignals": ["specific signals from the transcript"],
  "possibleReusableWork": true,
  "suggestedCapsule": {
    "title": "short provisional title if reusable work seems to be forming",
    "why": "why this may be reusable later",
    "reusableShape": "method, source, command shape, script, or workflow pattern",
    "likelyBindingSources": ["current files/config/tools that matter"],
    "usefulCommands": ["command shapes worth preserving, with placeholders for secrets/targets"]
  },
  "risks": ["things that look stale, unsafe, failed, or temporary"],
  "watchNext": ["what ARC should watch for next"],
  "reason": "short reason"
}

Rules:
- Be useful for debugging ARC, not verbose.
- Do not invent hidden Copilot reasoning. Use only the packet evidence.
- If a user supplied a local instruction/runbook/script and the main agent used it, identify the reusable method inside it rather than requiring that exact artifact later.
- If no durable workflow is visible yet, set possibleReusableWork to false and explain what evidence is still missing.
- Do not copy secrets. Describe parameters instead.

Live packet:
${JSON.stringify(packet).slice(0, 40000)}`;
}

async function runCopilotSidecar(prompt: string, workspace: string, model?: string): Promise<string> {
  const args = [
    "-p",
    prompt,
    "--allow-all",
    "--disable-builtin-mcps",
    "--no-auto-update",
    "--output-format",
    "json"
  ];
  if (model && model !== "auto") args.push("--model", model);
  const launcher = copilotSidecarCommand(args);
  // Each print-mode copilot run persists a resumable session; delete the ones
  // this run created so `copilot --resume` stays free of ARC's internal calls.
  const before = await listCopilotSessionIds();
  try {
    const output = await runProcess(launcher.command, launcher.args, workspace, "");
    return copilotJsonOutputContent(output) ?? output;
  } finally {
    const removed = await cleanupSidecarCopilotSessions(before).catch(() => []);
    if (removed.length) await debug("sidecar.sessions_cleaned", { removed }, workspace);
  }
}

function copilotJsonOutputContent(output: string): string | undefined {
  let content: string | undefined;
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as { type?: string; data?: { content?: unknown } };
      if (event.type === "assistant.message" && typeof event.data?.content === "string" && event.data.content.trim()) {
        content = event.data.content.trim();
      }
    } catch {
      // Non-JSON output remains valid for older Copilot commands.
    }
  }
  return content;
}

async function runOpencodeSidecar(prompt: string, workspace: string): Promise<string> {
  return runProcess(opencodeBin(), ["run", prompt], workspace, "");
}

async function runOllamaJudge(prompt: string, model: string): Promise<string> {
  const base = (process.env.OLLAMA_HOST || "http://127.0.0.1:11434").replace(/\/$/, "");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), sidecarTimeoutMs());
  try {
    const response = await fetch(`${base}/api/chat`, {
      method: "POST",
      signal: controller.signal,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model,
        stream: false,
        format: "json",
        options: { temperature: 0 },
        messages: [{ role: "user", content: prompt }]
      })
    });
    if (!response.ok) throw new Error(`Ollama judge returned ${response.status}`);
    const payload = await response.json() as { message?: { content?: string }; response?: string };
    return payload.message?.content ?? payload.response ?? "";
  } finally {
    clearTimeout(timer);
  }
}

function sidecarRunnerFor(runner: Runner | undefined): ModelSidecarRunner | null {
  const setting = modelSidecarSetting();
  if (setting === "off") return null;
  if (setting !== "auto") return setting;
  if (runner === "opencode" || runner === "copilot") return runner;
  return null;
}

function modelSidecarSetting(): ModelSidecarSetting {
  const value = (process.env.AGENT_RUN_CACHE_MODEL_SIDECAR || "auto").trim();
  if (!value || value === "auto" || value === "off" || value === "opencode" || value === "copilot") {
    return (value || "auto") as ModelSidecarSetting;
  }
  throw new Error("AGENT_RUN_CACHE_MODEL_SIDECAR must be auto, opencode, copilot, or off.");
}

function sidecarUnavailableReason(task: "review" | "consult" | "observe", runner: Runner | undefined): string {
  return `strong ${task} skipped: no same-runner model sidecar is configured for ${runner ?? "unknown"}`;
}

function isEvidencePacket(packet: ReviewPacket): packet is EvidencePacket {
  return "episodes" in packet;
}

function isAssembledDraft(packet: ReviewPacket): packet is AssembledDraft {
  return "packetKind" in packet && packet.packetKind === "assembled_draft";
}

function strongReviewInput(packet: ReviewPacket, intent: ReviewIntent): ReviewPacket {
  if (intent !== "auto" || !isEvidencePacket(packet)) return packet;
  if (process.env.AGENT_RUN_CACHE_REVIEW_FULL_PACKET === "1") return packet;
  return assembledDraftFromEvidence(packet);
}

export function assembledDraftFromEvidence(packet: EvidencePacket): AssembledDraft {
  const sourceEventIds = packet.toolEvents.map((event) => event.id);
  return {
    packetKind: "assembled_draft",
    runner: packet.runner,
    sessionId: packet.sessionId,
    workspace: packet.workspace,
    createdAt: new Date().toISOString(),
    goalId: sha256([packet.sessionId, packet.eventCount, ...sourceEventIds].join("\n")).slice(0, 12),
    mergeKey: draftMergeKeyFromEvidence(packet),
    span: {
      startEventId: sourceEventIds[0],
      endEventId: sourceEventIds.at(-1),
      eventCount: packet.eventCount
    },
    goal: packet.prompts.at(-1) ?? "",
    prompts: packet.prompts.slice(-5),
    evidenceSnippets: evidenceSnippetsFromPacket(packet),
    commands: packet.commands,
    parameters: unique([...packet.paths, ...packet.prompts.flatMap(parameterHintsFromPrompt)]).slice(0, 24),
    paths: packet.paths,
    outcome: packet.outcome,
    observations: [],
    sourceEventIds
  };
}

export function draftMergeKeyFromEvidence(packet: EvidencePacket): string {
  const source = packet.commands.some((value) => value.trim())
    ? packet.commands.slice(-6)
    : packet.prompts.slice(-3);
  const normalized = source
    .map((value) => portableSnippetText(redactSensitiveText(value), packet.workspace)
      .split(/\s+/)
      .filter(Boolean)
      .join(" ")
      .toLowerCase())
    .filter(Boolean)
    .join("\n");
  return normalized ? `draft:${sha256(normalized).slice(0, 20)}` : "";
}

function evidenceSnippetsFromPacket(packet: EvidencePacket): string[] {
  const startsById = new Map(
    packet.toolEvents
      .filter((event) => event.type === "tool_start")
      .map((event) => [toolEventId(event), event] as const)
      .filter((entry): entry is [string, EvidencePacket["toolEvents"][number]] => Boolean(entry[0]))
  );
  const completedIds = new Set(
    packet.toolEvents
      .filter((event) => event.type === "tool_end")
      .map(toolEventId)
      .filter((id): id is string => Boolean(id))
  );
  const completedCommandEvents = packet.toolEvents
    .filter((event) => event.type === "tool_end")
    .map((event) => ({ event, start: startsById.get(toolEventId(event) ?? "") }))
    .filter(({ event, start }) => event.exitCode !== undefined || Boolean(event.command ?? start?.command));
  const commandEventIds = new Set(
    completedCommandEvents.map(({ event }) => toolEventId(event)).filter((id): id is string => Boolean(id))
  );
  const completedCommands = completedCommandEvents
    .map(({ event, start }) => snippetFromCommandResult(event, start, packet.workspace));
  const failedResults = packet.toolEvents
    .filter((event) => event.type === "tool_end" && toolEventFailed(event))
    .filter((event) => {
      const id = toolEventId(event);
      return !id || !commandEventIds.has(id);
    })
    .map((event) => snippetFromToolEnd(event, packet.workspace, 700, true))
    .filter(Boolean);
  const incompleteCommands = packet.toolEvents
    .filter((event) => event.type === "tool_start" && Boolean(event.command))
    .filter((event) => {
      const id = toolEventId(event);
      return !id || !completedIds.has(id);
    })
    .map((event) => snippetFromIncompleteCommand(event, packet.workspace))
    .filter(Boolean);
  const genericResults = packet.toolEvents
    .filter((event) => event.type === "tool_end" && !toolEventFailed(event))
    .filter((event) => {
      const id = toolEventId(event);
      return !id || !commandEventIds.has(id);
    })
    .map((event) => snippetFromToolEnd(event, packet.workspace, 350, false))
    .filter(Boolean);
  return boundEvidenceSnippets(unique([
    ...completedCommands.slice(-4),
    ...failedResults.slice(-3),
    ...incompleteCommands.slice(-2),
    ...genericResults.slice(-4),
    ...packet.assistantMessages.filter((message) => message.trim()).slice(-2).map((message) => cleanSnippet(`assistant: ${message}`, 400, packet.workspace)).filter(Boolean)
  ]));
}

function toolEventId(event: EvidencePacket["toolEvents"][number]): string | undefined {
  if (event.toolUseId) return event.toolUseId;
  if (!event.raw || typeof event.raw !== "object") return undefined;
  const data = (event.raw as { data?: unknown }).data;
  if (!data || typeof data !== "object") return undefined;
  const toolCallId = (data as { toolCallId?: unknown }).toolCallId;
  return typeof toolCallId === "string" ? toolCallId : undefined;
}

function toolEventFailed(event: EvidencePacket["toolEvents"][number]): boolean {
  return event.toolStatus === "failed" || (event.exitCode !== undefined && event.exitCode !== 0);
}

function snippetFromCommandResult(
  event: EvidencePacket["toolEvents"][number],
  start: EvidencePacket["toolEvents"][number] | undefined,
  workspace: string
): string {
  const status = event.toolStatus ?? (event.exitCode === 0 ? "success" : event.exitCode !== undefined ? "failed" : "unknown");
  const result = event.exitCode !== undefined ? `exit code ${event.exitCode}` : `status ${status}`;
  const command = cleanSnippet(event.command ?? start?.command ?? event.toolName ?? "command", 260, workspace);
  const output = event.text ? `\noutput tail:\n${cleanTailSnippet(event.text, 420, workspace)}` : "";
  return cleanSnippet(`${status} command result (${result}): ${command}${output}`, 700, workspace);
}

function snippetFromIncompleteCommand(event: EvidencePacket["toolEvents"][number], workspace: string): string {
  return cleanSnippet(
    `incomplete command (no completion event observed): ${cleanSnippet(event.command ?? "", 340, workspace)}`,
    400,
    workspace
  );
}

function snippetFromToolEnd(
  event: EvidencePacket["toolEvents"][number],
  workspace: string,
  maxLength: number,
  useTail: boolean
): string {
  const label = event.toolName ?? "tool";
  const status = event.toolStatus ?? (event.exitCode === 0 ? "success" : event.exitCode !== undefined ? "failed" : "unknown");
  if (event.rawType === "fileChange") {
    const changes = fileChangeSummaries(event.raw, workspace);
    if (changes.length) {
      return cleanSnippet(`${status} ${label}: ${changes.join("; ")}`, 700, workspace);
    }
  }
  const command = event.command ? portableSnippetText(`${event.command}`, workspace) : label;
  const text = event.text
    ? `\n${useTail ? cleanTailSnippet(event.text, Math.max(0, maxLength - 100), workspace) : cleanSnippet(event.text, Math.max(0, maxLength - 100), workspace)}`
    : "";
  return cleanSnippet(`${status} ${label}: ${command}${text}`, maxLength, workspace);
}

function fileChangeSummaries(raw: unknown, workspace: string): string[] {
  if (!raw || typeof raw !== "object") return [];
  const changes = (raw as { changes?: unknown }).changes;
  if (!Array.isArray(changes)) return [];
  return changes.map((change) => {
    if (!change || typeof change !== "object") return "";
    const record = change as Record<string, unknown>;
    const path = typeof record.path === "string" ? portableSnippetPath(record.path, workspace) : "unknown path";
    const diff = typeof record.diff === "string" ? record.diff : "";
    const summary = diff ? ` ${diff}` : "";
    return cleanSnippet(`${path}${summary}`, 400, workspace);
  }).filter(Boolean).slice(0, 4);
}

function boundEvidenceSnippets(snippets: string[], maxTotalLength = 6000): string[] {
  const bounded: string[] = [];
  let used = 0;
  for (const snippet of snippets) {
    const remaining = maxTotalLength - used;
    if (remaining <= 0) break;
    const next = snippet.length > remaining ? `${snippet.slice(0, Math.max(0, remaining - 3)).trimEnd()}...` : snippet;
    bounded.push(next);
    used += next.length;
  }
  return bounded;
}

function cleanSnippet(value: string, maxLength: number, workspace: string): string {
  const compact = redactSensitiveText(portableSnippetText(value, workspace))
    .replace(/\r/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (compact.length <= maxLength) return compact;
  return `${compact.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function cleanTailSnippet(value: string, maxLength: number, workspace: string): string {
  const compact = redactSensitiveText(portableSnippetText(value, workspace))
    .replace(/\r/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (compact.length <= maxLength) return compact;
  return `...${compact.slice(-Math.max(0, maxLength - 3)).trimStart()}`;
}

function portableSnippetText(value: string, workspace: string): string {
  const root = resolve(workspace);
  return value.split(`${root}/`).join("").split(root).join(".");
}

function portableSnippetPath(value: string, workspace: string): string {
  if (!isAbsolute(value)) return value;
  const root = resolve(workspace);
  const rel = relative(root, value);
  if (rel && !rel.startsWith("..") && !isAbsolute(rel)) return rel;
  return portableSnippetText(value, workspace);
}

function parameterHintsFromPrompt(prompt: string): string[] {
  return prompt
    .split(/\s+/)
    .filter((token) => token.includes("/") || token.includes("=") || token.startsWith("--"))
    .map((token) => token.replace(/[.,;:]+$/, ""))
    .filter(Boolean)
    .slice(0, 12);
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function runJudgeSidecar(prompt: string, workspace: string, runner: ModelSidecarRunner, judgeModel?: JudgeModelSelection): Promise<string> {
  if (judgeModel?.provider === "ollama") return runOllamaJudge(prompt, judgeModel.id);
  if (judgeModel?.provider === "copilot") return runCopilotSidecar(prompt, workspace, judgeModel.id);
  return runModelSidecar(prompt, workspace, runner);
}

function runModelSidecar(prompt: string, workspace: string, runner: ModelSidecarRunner): Promise<string> {
  return runner === "copilot" ? runCopilotSidecar(prompt, workspace) : runOpencodeSidecar(prompt, workspace);
}

function opencodeBin(): string {
  return process.env.AGENT_RUN_CACHE_OPENCODE_BIN ?? "opencode";
}

async function runShellCommand(command: string, input: string): Promise<string> {
  return runProcess(process.env.SHELL ?? "/bin/sh", ["-lc", command], process.cwd(), input);
}

async function runProcess(command: string, args: string[], cwd: string, input: string): Promise<string> {
  const timeoutMs = sidecarTimeoutMs();
  const child = spawn(command, args, {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      AGENT_RUN_CACHE_IN_SIDECAR: "1"
    }
  });
  if (input) child.stdin.end(input);
  else child.stdin.end();
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

function sidecarTimeoutMs(): number {
  const value = Number(process.env.AGENT_RUN_CACHE_SIDECAR_TIMEOUT_MS ?? 120_000);
  return Number.isFinite(value) && value > 0 ? value : 120_000;
}

async function recordSidecarExchange(
  workspace: string,
  kind: "review" | "consult" | "observe",
  source: "command" | Runner | "ollama",
  input: string,
  output: string,
  parsed: unknown
): Promise<void> {
  await appendJsonl(sidecarPath(workspace), {
    timestamp: new Date().toISOString(),
    kind,
    source,
    inputHash: sha256(input),
    outputHash: sha256(output),
    inputBytes: Buffer.byteLength(input),
    outputBytes: Buffer.byteLength(output),
    inputPreview: redactSensitiveText(input).slice(0, 20000),
    outputPreview: redactSensitiveText(output).slice(0, 12000),
    parsed: redactJson(parsed)
  });
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
