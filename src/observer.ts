import { createHash } from "node:crypto";

import { buildEvidencePacket } from "./evidence.js";
import { appendJsonl } from "./json.js";
import { observerPath } from "./paths.js";
import { refreshCapsuleDerivedData } from "./retrieval.js";
import { observePacket, reviewPacket } from "./sidecar.js";
import { debug, saveCapsule } from "./store.js";
import type { ArcEvent, AssembledDraft, ObserverJudgment, ObserverPacket, SidecarReview } from "./types.js";

export interface LiveObserverOptions {
  sessionId: string;
  workspace: string;
  readEvents: () => Promise<ArcEvent[]>;
  intervalMs?: number;
  minEventsForJudgment?: number;
  minNewEventsForJudgment?: number;
  minMsBetweenJudgments?: number;
  maxSidecarCalls?: number;
}

export interface LiveObserver {
  stop: () => Promise<void>;
}

export function startLiveObserver(options: LiveObserverOptions): LiveObserver {
  const intervalMs = positiveNumber(options.intervalMs, "AGENT_RUN_CACHE_OBSERVER_INTERVAL_MS", 2000);
  const minEventsForJudgment = positiveNumber(options.minEventsForJudgment, "AGENT_RUN_CACHE_OBSERVER_MIN_EVENTS", 4);
  const minNewEventsForJudgment = positiveNumber(options.minNewEventsForJudgment, "AGENT_RUN_CACHE_OBSERVER_MIN_NEW_EVENTS", 4);
  const minMsBetweenJudgments = positiveNumber(options.minMsBetweenJudgments, "AGENT_RUN_CACHE_OBSERVER_MIN_MS", 45000);
  const maxSidecarCalls = positiveNumber(options.maxSidecarCalls, "AGENT_RUN_CACHE_OBSERVER_MAX_CALLS", 4);
  const startedAt = Date.now();
  const seen = new Set<string>();
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  let active: Promise<void> = Promise.resolve();
  let lastJudgedEventCount = 0;
  let lastJudgmentAt = 0;
  let sidecarCalls = 0;
  let draftReviewCalls = 0;
  let lastDraftReviewedEventCount = 0;
  let waitingLogged = false;
  const observations: ObserverJudgment[] = [];

  const tick = async (force = false): Promise<void> => {
    let events: ArcEvent[] = [];
    try {
      events = await options.readEvents();
    } catch (error) {
      await debug("observer.read_failed", { sessionId: options.sessionId, error: String(error) }, options.workspace);
      return;
    }
    if (!events.length) {
      if (!waitingLogged) {
        waitingLogged = true;
        await debug("observer.waiting_transcript", { sessionId: options.sessionId }, options.workspace);
      }
      return;
    }

    const newEvents = events.filter((event) => !seen.has(event.id));
    for (const event of newEvents) seen.add(event.id);
    if (newEvents.length) {
      await debug("observer.events", {
        sessionId: options.sessionId,
        total: events.length,
        newEvents: newEvents.map(summarizeEvent).slice(-12)
      }, options.workspace);
    }

    if (!shouldJudge(events, newEvents, force)) return;
    const packet = buildObserverPacket(events, newEvents, options.workspace, options.sessionId, Date.now() - startedAt);
    try {
      sidecarCalls += 1;
      const judgment = await observePacket(packet, options.workspace);
      lastJudgedEventCount = events.length;
      lastJudgmentAt = Date.now();
      if (judgment) {
        observations.push(judgment);
        if (observations.length > 20) observations.shift();
        await writeObservation(options.workspace, options.sessionId, packet, judgment);
        await debug("observer.judgment", {
          sessionId: options.sessionId,
          status: judgment.status,
          currentGoal: judgment.currentGoal,
          possibleReusableWork: judgment.possibleReusableWork,
          title: judgment.suggestedCapsule?.title
        }, options.workspace);
      } else {
        await debug("observer.no_judgment", { sessionId: options.sessionId, eventCount: events.length }, options.workspace);
      }
      if (shouldReviewClosedGoal(events, newEvents, judgment, force)) {
        await reviewClosedGoal(events, observations, options.workspace, options.sessionId);
      }
    } catch (error) {
      await debug("observer.judgment_failed", { sessionId: options.sessionId, error: String(error) }, options.workspace);
    }
  };

  const shouldJudge = (events: ArcEvent[], newEvents: ArcEvent[], force: boolean): boolean => {
    if (sidecarCalls >= maxSidecarCalls) return false;
    if (!events.some((event) => event.type === "user_prompt")) return false;
    if (events.length < minEventsForJudgment && !force) return false;
    if (force && events.length > lastJudgedEventCount) return true;
    if (newEvents.some((event) => event.type === "session_end")) return true;
    if (events.length - lastJudgedEventCount < minNewEventsForJudgment) return false;
    return Date.now() - lastJudgmentAt >= minMsBetweenJudgments;
  };

  const shouldReviewClosedGoal = (
    events: ArcEvent[],
    newEvents: ArcEvent[],
    judgment: ObserverJudgment | null,
    force: boolean
  ): boolean => {
    if (process.env.AGENT_RUN_CACHE_OBSERVER_DRAFT_REVIEW === "0") return false;
    if (draftReviewCalls >= maxSidecarCalls) return false;
    if (events.length <= lastDraftReviewedEventCount) return false;
    if (!events.some((event) => event.type === "tool_start" || event.type === "tool_end")) return false;
    const closed = force
      || newEvents.some((event) => event.type === "session_end")
      || judgment?.status === "likely_done";
    return closed;
  };

  const reviewClosedGoal = async (
    events: ArcEvent[],
    currentObservations: ObserverJudgment[],
    workspace: string,
    sessionId: string
  ): Promise<void> => {
    const draft = buildAssembledDraft(events, currentObservations, workspace, sessionId);
    draftReviewCalls += 1;
    lastDraftReviewedEventCount = events.length;
    await writeDraft(workspace, sessionId, draft);
    await debug("observer.draft_review_queued", {
      sessionId,
      goalId: draft.goalId,
      eventCount: draft.span.eventCount,
      commandCount: draft.commands.length,
      outcome: draft.outcome.status
    }, workspace);
    const review = await reviewPacket(draft, workspace);
    const saved: string[] = [];
    for (const capsuleInput of reviewCapsules(review).filter((capsule) => capsuleAllowedForOutcome(capsule, draft.outcome.status))) {
      const capsule = await saveCapsule({
        ...capsuleInput,
        sourceSessionId: `${sessionId}:${draft.goalId}`,
        workspace,
        runner: draft.runner,
        outcomeStatus: draft.outcome.status
      }, workspace);
      if (capsule) {
        const enriched = await refreshCapsuleDerivedData(capsule, workspace);
        saved.push(enriched.id);
      }
    }
    await debug(saved.length ? "observer.draft_review_saved" : "observer.draft_review_no_capsule", {
      sessionId,
      goalId: draft.goalId,
      capsuleIds: saved,
      reason: review?.reason
    }, workspace);
  };

  const schedule = (delay: number): void => {
    if (stopped) return;
    timer = setTimeout(() => {
      active = tick(false).finally(() => schedule(intervalMs));
    }, delay);
    timer.unref?.();
  };

  debug("observer.started", {
    sessionId: options.sessionId,
    intervalMs,
    maxSidecarCalls
  }, options.workspace).catch(() => undefined);
  schedule(0);

  return {
    stop: async () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      await active;
      await tick(true);
      await debug("observer.stopped", { sessionId: options.sessionId, sidecarCalls, draftReviewCalls }, options.workspace);
    }
  };
}

function buildAssembledDraft(
  events: ArcEvent[],
  observations: ObserverJudgment[],
  workspace: string,
  sessionId: string
): AssembledDraft {
  const packet = buildEvidencePacket(events, workspace, sessionId);
  const sourceEventIds = events.map((event) => event.id);
  const goal = observations.map((observation) => observation.currentGoal).filter(Boolean).at(-1)
    ?? packet.prompts.at(-1)
    ?? "";
  return {
    packetKind: "assembled_draft",
    runner: packet.runner,
    sessionId,
    workspace,
    createdAt: new Date().toISOString(),
    goalId: hash(sourceEventIds.join("\n")).slice(0, 12),
    span: {
      startEventId: events[0]?.id,
      endEventId: events.at(-1)?.id,
      eventCount: events.length
    },
    goal,
    prompts: packet.prompts.slice(-5),
    commands: packet.commands,
    parameters: unique([...packet.paths, ...packet.prompts.flatMap(parameterHintsFromPrompt)]).slice(0, 24),
    paths: packet.paths,
    outcome: packet.outcome,
    observations: observations.slice(-8),
    sourceEventIds
  };
}

function buildObserverPacket(events: ArcEvent[], newEvents: ArcEvent[], workspace: string, sessionId: string, elapsedMs: number): ObserverPacket {
  const recent = events.slice(-40);
  return {
    runner: "copilot",
    sessionId,
    workspace,
    createdAt: new Date().toISOString(),
    elapsedMs,
    eventCount: events.length,
    newEventCount: newEvents.length,
    prompts: events.filter((event) => event.type === "user_prompt").map((event) => event.text ?? "").filter(Boolean).slice(-5),
    assistantMessages: events.filter((event) => event.type === "assistant_message").map((event) => event.text ?? "").filter(Boolean).slice(-8),
    commands: unique(events.map((event) => event.command ?? "").filter(Boolean)).slice(-20),
    paths: unique(events.map((event) => event.path ?? "").filter(Boolean)).slice(-20),
    recentEvents: recent
  };
}

async function writeObservation(workspace: string, sessionId: string, packet: ObserverPacket, judgment: ObserverJudgment): Promise<void> {
  await appendJsonl(observerPath(sessionId, workspace), {
    timestamp: new Date().toISOString(),
    sessionId,
    eventCount: packet.eventCount,
    judgment
  });
}

async function writeDraft(workspace: string, sessionId: string, draft: AssembledDraft): Promise<void> {
  await appendJsonl(observerPath(sessionId, workspace), {
    timestamp: new Date().toISOString(),
    sessionId,
    eventCount: draft.span.eventCount,
    draft
  });
}

function reviewCapsules(review: SidecarReview | null): NonNullable<SidecarReview["capsules"]> {
  if (!review || review.shouldSave === false) return [];
  if (Array.isArray(review.capsules) && review.capsules.length) return review.capsules;
  return review.capsule ? [review.capsule] : [];
}

function capsuleAllowedForOutcome(capsule: NonNullable<SidecarReview["capsules"]>[number], status: string): boolean {
  if (status !== "failed" && status !== "aborted") return true;
  const kind = String(capsule.kind ?? "").toLowerCase();
  if (kind.includes("fact") || kind.includes("dead_end") || kind.includes("caution")) return true;
  const failedAttempts = capsule.workflow?.failedAttempts ?? [];
  const successCriteria = capsule.workflow?.successCriteria ?? [];
  return failedAttempts.length > 0 && successCriteria.length === 0;
}

function summarizeEvent(event: ArcEvent): Record<string, unknown> {
  return {
    type: event.type,
    rawType: event.rawType,
    toolName: event.toolName,
    command: truncate(event.command, 220),
    text: truncate(event.text, 220)
  };
}

function positiveNumber(input: number | undefined, envName: string, fallback: number): number {
  const raw = input ?? Number(process.env[envName] ?? fallback);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function parameterHintsFromPrompt(prompt: string): string[] {
  return prompt
    .split(/\s+/)
    .filter((token) => token.includes("/") || token.includes("=") || token.startsWith("--"))
    .map((token) => token.replace(/[.,;:]+$/, ""))
    .filter(Boolean)
    .slice(0, 12);
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function truncate(value: string | undefined, limit: number): string | undefined {
  if (!value) return undefined;
  return value.length > limit ? `${value.slice(0, limit)}...` : value;
}
