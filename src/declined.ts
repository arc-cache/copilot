import { createHash } from "node:crypto";

import { readJsonl, writeJsonl } from "./json.js";
import { recordMemoryEvent } from "./ledger.js";
import { declinedPath } from "./paths.js";
import { redactJson } from "./redact.js";
import { recordJudgeDecision } from "./retrieval-reputation.js";
import { loadCapsules, saveCapsule } from "./store.js";
import type { Capsule, EvidenceOutcomeStatus, ReviewPacket, ReviewRecurrence } from "./types.js";

export interface DeclinedDraftRecord {
  id: string;
  mergeKey: string;
  createdAt: string;
  sessionId: string;
  outcome: string;
  reason: string;
  draft?: ReviewPacket;
  promotedAt?: string;
  promotedCapsuleId?: string;
}

export interface DeclinedDraftView {
  id: string;
  mergeKey: string;
  title: string;
  summary: string;
  sessionId: string;
  outcome: string;
  reason: string;
  createdAt: string;
  ageSeconds: number;
}

export async function reviewRecurrence(
  mergeKey: string,
  sessionId: string,
  workspace: string
): Promise<ReviewRecurrence | undefined> {
  if (!mergeKey) return undefined;
  const records = await loadRetainedDeclinedDrafts(workspace);
  const priorSessionIds: string[] = [];
  const seen = new Set<string>();
  let priorDeclineReason = "";
  for (const record of records) {
    if (record.mergeKey !== mergeKey || record.sessionId === sessionId || seen.has(record.sessionId)) continue;
    seen.add(record.sessionId);
    priorSessionIds.push(record.sessionId);
    priorDeclineReason = record.reason;
  }
  if (!priorSessionIds.length) return undefined;
  return {
    mergeKey,
    recurrenceCount: priorSessionIds.length + 1,
    priorDeclineReason,
    priorSessionIds
  };
}

export async function recordDeclinedDraft(
  mergeKey: string,
  sessionId: string,
  outcome: string,
  reason: string,
  workspace: string,
  draft?: ReviewPacket
): Promise<void> {
  if (!mergeKey) return;
  const record = {
    id: `declined-${sha256(`${sessionId}\n${mergeKey}`).slice(0, 16)}`,
    mergeKey,
    createdAt: new Date().toISOString(),
    sessionId,
    outcome,
    reason,
    draft: draft ? redactJson(draft) as ReviewPacket : undefined
  } satisfies DeclinedDraftRecord;
  const records = (await loadRetainedDeclinedDrafts(workspace)).filter((item) => item.id !== record.id);
  records.push(record);
  await writeRetainedDeclinedDrafts(records, workspace);
}

export async function loadDeclinedDraftViews(workspace: string): Promise<DeclinedDraftView[]> {
  return (await loadRetainedDeclinedDrafts(workspace))
    .filter((record) => !record.promotedCapsuleId)
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))
    .map(declinedDraftView);
}

export async function promoteDeclinedDraft(
  idOrPrefix: string,
  workspace: string
): Promise<{ declinedDraftId: string; capsule: Capsule }> {
  const records = await loadRetainedDeclinedDrafts(workspace);
  const record = records.find((item) => item.id === idOrPrefix || item.id.startsWith(idOrPrefix));
  if (!record) throw new Error(`No declined draft matches ${idOrPrefix}`);
  if (record.promotedCapsuleId) {
    const capsule = (await loadCapsules(workspace)).find((item) => item.id === record.promotedCapsuleId);
    if (!capsule) throw new Error("Declined draft was promoted, but its capsule is missing");
    return { declinedDraftId: record.id, capsule };
  }
  if (!record.draft) throw new Error("Declined draft predates recoverable draft storage");
  const capsule = await saveCapsule(capsuleFromDeclinedDraft(record, workspace), workspace);
  if (!capsule) throw new Error("Declined draft could not be promoted");
  record.promotedAt = new Date().toISOString();
  record.promotedCapsuleId = capsule.id;
  await writeRetainedDeclinedDrafts(records, workspace);
  await recordMemoryEvent({
    type: "capsule.promoted",
    workspace,
    sessionId: record.sessionId,
    capsuleId: capsule.id,
    details: {
      declinedDraftId: record.id,
      promotedBy: "user",
      title: capsule.title,
      reason: "user promoted a declined draft"
    }
  });
  await recordJudgeDecision({
    workspace,
    sessionId: record.sessionId,
    prompt: `user promoted declined draft ${record.id}`,
    mode: "user-override",
    candidates: [{ capsuleId: capsule.id, score: 1 }],
    verdict: {
      inject: capsule.id,
      abstain: false,
      confidence: 1,
      reason: "user promoted a previously declined draft"
    },
    outcome: { injected: true, used: "yes", helped: "yes" }
  });
  return { declinedDraftId: record.id, capsule };
}

function capsuleFromDeclinedDraft(record: DeclinedDraftRecord, workspace: string): Partial<Capsule> {
  const draft = record.draft!;
  const goal = "goal" in draft && draft.goal.trim()
    ? draft.goal
    : draft.prompts.filter((value) => value.trim()).at(-1) ?? "Recovered declined method";
  const evidence = "evidenceSnippets" in draft ? draft.evidenceSnippets ?? [] : [];
  const commands = draft.commands ?? [];
  const parameters = "parameters" in draft ? draft.parameters : [];
  const paths = draft.paths ?? [];
  const successful = record.outcome === "success";
  const title = truncate(goal, 100);
  return {
    runner: draft.runner,
    workspace,
    sourceSessionId: record.sessionId,
    sourceSessionIds: [record.sessionId],
    status: "local",
    privacyLabel: "local",
    kind: successful ? "workflow" : "project_fact",
    mergeKey: record.mergeKey,
    title,
    summary: successful
      ? `User-promoted method recovered from verified evidence: ${title}`
      : `User-promoted caution recovered from a ${record.outcome} goal: ${title}`,
    reusable: true,
    confidence: successful ? 0.5 : 0.35,
    reuseWhen: [goal],
    doNotReuseWhen: successful ? [] : [`when the ${record.outcome} outcome has not been independently revalidated`],
    evidence,
    provenance: ["promoted-by-user", `declinedDraft:${record.id}`],
    artifactSources: [],
    supersedes: [],
    confidenceReason: `Conservative confidence because the reviewer declined this ${record.outcome} draft before explicit user promotion.`,
    failureBoundary: successful
      ? [`Original reviewer declined capture: ${record.reason}`]
      : [`Original outcome was ${record.outcome}; do not treat this as a verified positive workflow.`],
    validationProvenance: [`original draft outcome: ${record.outcome}`, "promoted explicitly by user"],
    outcomeStatus: normalizedOutcome(record.outcome),
    nextRunInstruction: successful
      ? `Reuse the recorded method for ${goal}, then verify the same success evidence.`
      : `Treat the prior ${record.outcome} result as a caution and verify fresh evidence before acting.`,
    workflow: {
      purpose: goal,
      parameters,
      bindingSources: paths.slice(0, 12),
      steps: successful ? commands : ["Inspect the recorded failure evidence before choosing a new route."],
      commands: successful ? commands : [],
      successCriteria: successful
        ? evidence.filter((value) => /success|exit code 0/i.test(value)).slice(0, 4)
        : [],
      failedAttempts: successful ? [] : commands,
      validationProbe: successful ? commands.slice(-1) : []
    }
  };
}

async function loadRetainedDeclinedDrafts(workspace: string): Promise<DeclinedDraftRecord[]> {
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  return (await readJsonl<DeclinedDraftRecord>(declinedPath(workspace)))
    .filter((record) => Number.isFinite(Date.parse(record.createdAt)) && Date.parse(record.createdAt) >= cutoff)
    .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt))
    .slice(-50);
}

async function writeRetainedDeclinedDrafts(records: DeclinedDraftRecord[], workspace: string): Promise<void> {
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const retained = records
    .filter((record) => Number.isFinite(Date.parse(record.createdAt)) && Date.parse(record.createdAt) >= cutoff)
    .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt))
    .slice(-50);
  await writeJsonl(declinedPath(workspace), retained);
}

function declinedDraftView(record: DeclinedDraftRecord): DeclinedDraftView {
  const draft = record.draft;
  const title = draft && "goal" in draft && draft.goal.trim() ? truncate(draft.goal, 100) : "Declined capture";
  const summary = draft && "evidenceSnippets" in draft
    ? truncate(draft.evidenceSnippets?.[0] ?? `${record.outcome} outcome`, 180)
    : `${record.outcome} outcome`;
  return {
    id: record.id,
    mergeKey: record.mergeKey,
    title,
    summary,
    sessionId: record.sessionId,
    outcome: record.outcome,
    reason: record.reason,
    createdAt: record.createdAt,
    ageSeconds: Math.max(0, Math.floor((Date.now() - Date.parse(record.createdAt)) / 1000))
  };
}

function normalizedOutcome(value: string): EvidenceOutcomeStatus {
  return ["success", "partial", "failed", "aborted", "unknown"].includes(value)
    ? value as EvidenceOutcomeStatus
    : "unknown";
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
