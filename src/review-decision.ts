import { recordMemoryEvent } from "./ledger.js";
import { reviewEvents, type ReviewOutcome } from "./review.js";
import { debug, recordReview, traceHash } from "./store.js";
import type { ArcEvent, InjectionPlan, SidecarReviewOptions } from "./types.js";

export interface ReviewDecision {
  title: string;
  status: string;
  text: string;
}

export interface ReviewTurnOptions extends SidecarReviewOptions {
  reviewMode?: string;
  sessionId?: string;
}

export async function maybeReviewTurn(
  events: ArcEvent[],
  plan: InjectionPlan,
  runnerStatus: "completed" | "failed",
  turnId: string,
  turnWorkspace: string,
  options: ReviewTurnOptions = {}
): Promise<ReviewDecision | null> {
  const reviewMode = options.reviewMode ?? process.env.ARC_APP_REVIEW ?? "auto";
  const sessionId = options.sessionId ?? events[0]?.sessionId ?? turnId;
  if (reviewMode === "off" || runnerStatus !== "completed") {
    const reason = reviewMode === "off" ? "review disabled" : "runner did not complete";
    const reviewOptions = reviewOptionsFromPlan(plan, options);
    const details = runnerStatus === "completed" ? { reason } : failedRunnerRejectionDetails(events, plan, reviewOptions, reason);
    await recordRejectionAuditRow(events, turnWorkspace, sessionId, turnId, reason, runnerStatus, "fast-path", reviewOptions.injectedCapsuleIds);
    await recordMemoryEvent({
      type: "capsule.rejected",
      workspace: turnWorkspace,
      sessionId,
      turnId,
      details
    });
    return null;
  }

  const reviewDecision = shouldOfferReview(events, plan, runnerStatus);
  if (!reviewDecision.reviewable) {
    if (reviewDecision.reason === "turn awaiting user input") return null;
    const reviewOptions = reviewOptionsFromPlan(plan, options);
    await recordRejectionAuditRow(events, turnWorkspace, sessionId, turnId, reviewDecision.reason, runnerStatus, "fast-path", reviewOptions.injectedCapsuleIds);
    await recordMemoryEvent({
      type: "capsule.rejected",
      workspace: turnWorkspace,
      sessionId,
      turnId,
      details: { reason: reviewDecision.reason }
    });
    return null;
  }

  // Memory is automatic: the local observer gates inside the review path and
  // the strong reviewer decides what to capsule. The chat timeline only ever
  // shows an item when something was actually saved; declines and no-capsule
  // outcomes live in the memory ledger and Activity feed instead.
  const review = await runReviewEvents(events, turnId, turnWorkspace, "turn-idle", reviewOptionsFromPlan(plan, options));
  return review.status === "saved" ? review : null;
}

export async function recordRejectionAuditRow(
  events: ArcEvent[],
  workspace: string,
  sessionId: string,
  turnId: string,
  reason: string,
  runnerStatus: "completed" | "failed",
  rejectionPath: string,
  injectedCapsuleIds: string[] | undefined = undefined
): Promise<void> {
  await recordReview({
    sessionId,
    traceHash: traceHash(events),
    eventCount: events.length,
    status: runnerStatus === "failed" ? "failed" : "no_capsule",
    reason,
    turnId,
    rejectionPath,
    runnerStatus,
    injectedCapsuleIds
  }, workspace);
}

export function reviewOptionsFromPlan(plan: InjectionPlan, options: SidecarReviewOptions = {}): SidecarReviewOptions {
  const injectedCapsuleIds = plan.capsule?.id
    ? [...new Set([...(options.injectedCapsuleIds ?? []), plan.capsule.id])]
    : options.injectedCapsuleIds;
  const judgeDecisionIds = plan.judgeDecisionId
    ? [...new Set([...(options.judgeDecisionIds ?? []), plan.judgeDecisionId])]
    : options.judgeDecisionIds;
  return {
    ...options,
    injectedCapsuleIds,
    judgeDecisionIds,
    consultApplied: plan.consultApplied ?? options.consultApplied,
    consultCapsuleId: plan.consultCapsuleId ?? options.consultCapsuleId,
    consultAbstainReason: plan.consultAbstainReason ?? options.consultAbstainReason,
    actionRisk: plan.actionRisk ?? options.actionRisk
  };
}

export function failedRunnerRejectionDetails(
  events: ArcEvent[],
  plan: InjectionPlan | null,
  options: SidecarReviewOptions = {},
  reason = "runner did not complete"
): Record<string, unknown> {
  const toolEvents = events.filter((event) => event.type === "tool_start" || event.type === "tool_end");
  const toolEnds = events.filter((event) => event.type === "tool_end");
  const assistantCount = events.filter((event) => event.type === "assistant_message" && (event.text ?? "").trim()).length;
  const lastTool = toolEnds.at(-1) ?? toolEvents.at(-1);
  const text = events.map((event) => `${event.command ?? ""}\n${event.text ?? ""}`).join("\n").toLowerCase();
  const injectedCapsuleIds = plan?.capsule?.id
    ? [...new Set([...(options.injectedCapsuleIds ?? []), plan.capsule.id])]
    : options.injectedCapsuleIds ?? [];
  return {
    reason,
    failureKind: classifyFailedRunner(events, text, assistantCount, toolEvents.length, toolEnds.length),
    toolCount: toolEvents.length,
    lastToolStatus: lastToolStatus(lastTool),
    externalMutationRisk: externalMutationRisk(text),
    injectedCapsuleIds
  };
}

function classifyFailedRunner(events: ArcEvent[], text: string, assistantCount: number, toolCount: number, toolEndCount: number): string {
  if (!assistantCount && !toolCount) return "no_assistant_output";
  if (/\b(permission|approval|authorize|allowed).{0,80}\b(timeout|timed out|expired)\b/.test(text)) return "permission_request_timeout";
  if (events.some((event) => event.rawType?.toLowerCase().includes("interrupt")) || /\b(interrupted|aborted|cancelled|canceled|stopped by user)\b/.test(text)) return "interrupted_tools";
  if (/\b(timeout|timed out|still running|waiting for session|session\\.idle)\b/.test(text) && toolCount > toolEndCount) return "timeout_pending_shell";
  if (/\b(timeout|timed out|still running|waiting for session|session\\.idle)\b/.test(text) && toolCount > 0) return "timeout_after_partial_validation";
  return "failed_runner";
}

function lastToolStatus(event: ArcEvent | undefined): string {
  if (!event) return "none";
  if (event.toolStatus) return event.toolStatus;
  if (typeof event.exitCode === "number") return event.exitCode === 0 ? "success" : "failed";
  return event.type === "tool_start" ? "started" : "unknown";
}

function externalMutationRisk(text: string): boolean {
  return /\b(external-runner|docker\s+exec|kubectl|deploy|restart|write|apply|provision|connect)\b/.test(text);
}

async function runReviewEvents(
  events: ArcEvent[],
  turnId: string,
  turnWorkspace: string,
  review: string,
  options: SidecarReviewOptions = {}
): Promise<ReviewDecision> {
  const sessionId = events[0]?.sessionId ?? turnId;
  try {
    // The observer gate only filters ARC-initiated reviews; an explicit user
    // save goes straight to the strong reviewer.
    const intent = review === "user-save" ? "user-requested" : "auto";
    const outcome = await reviewEvents(events, turnWorkspace, turnId, intent, options);
    await recordMemoryEvent({
      type: "capsule.checkpointed",
      workspace: turnWorkspace,
      sessionId,
      turnId,
      details: { eventCount: events.length, review, outcome: outcome.status, reason: outcome.reason, capsuleIds: outcome.capsuleIds }
    });
    return reviewDecisionFromOutcome(outcome);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await debug("app_server.review_failed", { error: message }, turnWorkspace);
    await recordMemoryEvent({
      type: "capsule.rejected",
      workspace: turnWorkspace,
      sessionId,
      turnId,
      details: { reason: "review failed", error: message.slice(0, 500) }
    });
    return { title: "Memory review failed", status: "failed", text: message };
  }
}

export function reviewDecisionFromOutcome(outcome: ReviewOutcome): ReviewDecision {
  switch (outcome.status) {
    case "saved": {
      const count = outcome.capsuleIds?.length ?? 0;
      return {
        title: "Memory saved",
        status: "saved",
        text: count ? `Saved ${count} capsule${count === 1 ? "" : "s"} to memory.` : "Capsule saved to memory."
      };
    }
    case "no_capsule":
      return {
        title: "Memory review completed",
        status: "no_capsule",
        text: outcome.reason ?? "Nothing reusable to save from this turn."
      };
    case "skipped":
      return {
        title: "Memory review skipped",
        status: "skipped",
        text: outcome.reason ?? "Review skipped."
      };
    case "failed":
    default:
      return {
        title: "Memory review failed",
        status: "failed",
        text: outcome.reason ?? "Review failed."
      };
  }
}

export function shouldOfferReview(
  events: ArcEvent[],
  plan: InjectionPlan,
  runnerStatus: "completed" | "failed"
): { reviewable: boolean; reason: string } {
  if (runnerStatus !== "completed") return { reviewable: false, reason: "runner did not complete" };
  // The turn ended on an open ask_user question, so it is blocked on the user rather than
  // genuinely done. Defer the review until the conversation resumes and actually completes.
  if (events.some((event) => event.type === "awaiting_input")) {
    return { reviewable: false, reason: "turn awaiting user input" };
  }
  if (events.some((event) => (event.type === "tool_start" || event.type === "tool_end") && event.source !== "opencode-run")) {
    return { reviewable: true, reason: "tool activity observed" };
  }
  if (plan.shouldInject) return { reviewable: true, reason: "capsule context was injected" };
  const prompt = events.find((event) => event.type === "user_prompt")?.text ?? "";
  const assistant = events
    .filter((event) => event.type === "assistant_message")
    .map((event) => event.text ?? "")
    .join("\n");
  if (isSmallTalk(prompt)) return { reviewable: false, reason: "small-talk turn" };
  const text = `${prompt}\n${assistant}`;
  if (hasReusableWorkSignal(text)) return { reviewable: true, reason: "reusable-work signal observed" };
  if (prompt.length > 120 || assistant.length > 1500) return { reviewable: true, reason: "substantial turn" };
  return { reviewable: false, reason: "no reusable-work signal" };
}

function isSmallTalk(prompt: string): boolean {
  const normalized = prompt.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  if (!normalized) return true;
  const smallTalk = new Set(["hi", "hello", "hey", "yo", "sup", "thanks", "thank you", "ok", "okay", "cool", "nice", "lol", "haha"]);
  return smallTalk.has(normalized);
}

function hasReusableWorkSignal(value: string): boolean {
  const text = value.toLowerCase();
  return /\b(test|build|fix|debug|implement|refactor|file|folder|repo|command|script|deploy|api|ssh|docker|github|error|failing|trace|cache|capsule|workflow|config|install|run)\b/.test(text);
}
