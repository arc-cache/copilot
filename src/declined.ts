import { createHash } from "node:crypto";

import { appendJsonl, readJsonl } from "./json.js";
import { declinedPath } from "./paths.js";
import type { ReviewRecurrence } from "./types.js";

export interface DeclinedDraftRecord {
  id: string;
  mergeKey: string;
  createdAt: string;
  sessionId: string;
  outcome: string;
  reason: string;
}

export async function reviewRecurrence(
  mergeKey: string,
  sessionId: string,
  workspace: string
): Promise<ReviewRecurrence | undefined> {
  if (!mergeKey) return undefined;
  const records = await readJsonl<DeclinedDraftRecord>(declinedPath(workspace));
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
  workspace: string
): Promise<void> {
  if (!mergeKey) return;
  await appendJsonl(declinedPath(workspace), {
    id: `declined-${sha256(`${sessionId}\n${mergeKey}`).slice(0, 16)}`,
    mergeKey,
    createdAt: new Date().toISOString(),
    sessionId,
    outcome,
    reason
  } satisfies DeclinedDraftRecord);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
