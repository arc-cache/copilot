import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";

import { appendJsonl, readJsonl, writeJsonl } from "./json.js";
import { recordMemoryEvent } from "./ledger.js";
import { debugPath, memoryLockPath, memoryPath, reviewLockPath, reviewedPath, tracePath, workspaceGroup, workspaceKey, workspaceRoot } from "./paths.js";
import { redactSensitiveText } from "./redact.js";
import type {
  ArcEvent,
  BindingSourceSnapshot,
  Capsule,
  CapsuleEmbedding,
  CapsuleGraphEdge,
  CapsuleStatus,
  CapsuleStaleness,
  EvidenceOutcomeStatus,
  PrivacyLabel,
  WorkflowCapsule
} from "./types.js";

export interface ReviewRecord {
  sessionId: string;
  workspace: string;
  traceHash: string;
  eventCount: number;
  status: "saved" | "no_capsule" | "failed";
  capsuleId?: string;
  reason?: string;
  turnId?: string;
  rejectionPath?: string;
  runnerStatus?: "completed" | "failed";
  injectedCapsuleIds?: string[];
  createdAt: string;
}

export async function debug(action: string, details: Record<string, unknown> = {}, workspace = workspaceRoot()): Promise<void> {
  await appendJsonl(debugPath(workspace), {
    timestamp: new Date().toISOString(),
    action,
    details
  });
}

export async function loadCapsules(workspace = workspaceRoot()): Promise<Capsule[]> {
  return compactCapsules(await loadStoredCapsules(workspace));
}

async function loadStoredCapsules(workspace: string): Promise<Capsule[]> {
  const values = await readJsonl<unknown>(memoryPath(workspace));
  return values.filter(isCapsule).map((capsule) => normalizeLoadedCapsule(capsule, workspace));
}

export async function saveCapsule(input: Partial<Capsule>, workspace = workspaceRoot()): Promise<Capsule | null> {
  if (!input.reusable) return null;
  return withMemoryLock(workspace, () => saveCapsuleUnlocked(input, workspace));
}

async function saveCapsuleUnlocked(input: Partial<Capsule>, workspace: string): Promise<Capsule | null> {
  const now = new Date().toISOString();
  const capsule = normalizeCapsule(input, workspace, now);
  const compacted = compactCapsulesWithMergeRecords(await loadStoredCapsules(workspace));
  const existing = compacted.capsules;
  const index = findMergeIndex(existing, capsule);
  const previousOutcomeStatus = index >= 0 ? existing[index].outcomeStatus : undefined;
  if (index >= 0) {
    existing[index] = mergeCapsules(existing[index], capsule, now);
  } else {
    existing.push(capsule);
  }
  const saved = index >= 0 ? existing[index] : capsule;
  const superseded = applySupersession(existing, saved);
  await writeJsonl(memoryPath(workspace), existing);
  await debug("capsule.saved", {
    title: capsule.title,
    id: saved.id,
    sessionId: capsule.sourceSessionId,
    durableCapsuleId: saved.id,
    draftCapsuleId: capsule.id,
    replacementCandidateId: capsule.id !== saved.id ? capsule.id : undefined,
    replaced: index >= 0
  }, workspace);
  for (const merged of compacted.merged) {
    await recordCapsuleMergedEvent(workspace, merged.from, merged.to, merged.reason);
  }
  await recordMemoryEvent({
    type: index >= 0 ? "capsule.updated" : "capsule.created",
    workspace,
    sessionId: saved.sourceSessionId,
    capsuleId: saved.id,
    details: {
      title: saved.title,
      mergeKey: saved.mergeKey,
      kind: saved.kind,
      outcomeStatus: saved.outcomeStatus,
      sourceOutcomeStatuses: index >= 0 ? {
        existing: previousOutcomeStatus,
        incoming: capsule.outcomeStatus,
        final: saved.outcomeStatus
      } : undefined,
      sourceSessionIds: saved.sourceSessionIds
    }
  });
  if (index >= 0 && capsule.id !== saved.id) {
    await recordCapsuleMergedEvent(workspace, capsule, saved, "save matched an existing durable capsule");
  }
  for (const capsuleId of superseded) {
    await recordMemoryEvent({
      type: "capsule.superseded",
      workspace,
      sessionId: saved.sourceSessionId,
      capsuleId,
      details: { supersededBy: saved.id, supersedingTitle: saved.title }
    });
  }
  return saved;
}

async function recordCapsuleMergedEvent(workspace: string, from: Capsule, to: Capsule, reason: string): Promise<void> {
  await recordMemoryEvent({
    type: "capsule.merged",
    workspace,
    sessionId: from.sourceSessionId,
    capsuleId: from.id,
    details: {
      fromCapsuleId: from.id,
      toCapsuleId: to.id,
      fromKind: from.kind,
      toKind: to.kind,
      fromMergeKey: from.mergeKey,
      toMergeKey: to.mergeKey,
      movedSourceSessionIds: unique([...from.sourceSessionIds, from.sourceSessionId]),
      reason
    }
  });
}

export async function updateCapsuleMetadata(
  idOrPrefix: string,
  patch: Partial<Pick<Capsule, "status" | "privacyLabel" | "workspaceGroup" | "useCount" | "successCount" | "failureCount">>,
  workspace = workspaceRoot()
): Promise<Capsule | null> {
  return withMemoryLock(workspace, () => updateCapsuleMetadataUnlocked(idOrPrefix, patch, workspace));
}

async function updateCapsuleMetadataUnlocked(
  idOrPrefix: string,
  patch: Partial<Pick<Capsule, "status" | "privacyLabel" | "workspaceGroup" | "useCount" | "successCount" | "failureCount">>,
  workspace: string
): Promise<Capsule | null> {
  const capsules = await loadCapsules(workspace);
  const index = capsules.findIndex((capsule) => capsule.id === idOrPrefix || capsule.id.startsWith(idOrPrefix));
  if (index < 0) return null;
  const now = new Date().toISOString();
  const current = capsules[index];
  const next: Capsule = {
    ...current,
    status: normalizeStatus(patch.status ?? current.status),
    privacyLabel: normalizePrivacyLabel(patch.privacyLabel ?? current.privacyLabel),
    workspaceGroup: clean(patch.workspaceGroup ?? current.workspaceGroup),
    useCount: countValue(patch.useCount ?? current.useCount),
    successCount: countValue(patch.successCount ?? current.successCount),
    failureCount: countValue(patch.failureCount ?? current.failureCount),
    updatedAt: now
  };
  capsules[index] = next;
  await writeJsonl(memoryPath(workspace), capsules);
  await debug("capsule.metadata_updated", {
    id: next.id,
    title: next.title,
    status: next.status,
    privacyLabel: next.privacyLabel,
    workspaceGroup: next.workspaceGroup
  }, workspace);
  await recordMemoryEvent({
    type: "capsule.privacy_updated",
    workspace,
    sessionId: next.sourceSessionId,
    capsuleId: next.id,
    details: {
      title: next.title,
      status: next.status,
      privacyLabel: next.privacyLabel,
      workspaceGroup: next.workspaceGroup
    }
  });
  return next;
}

export async function incrementCapsuleUse(idOrPrefix: string, workspace = workspaceRoot()): Promise<Capsule | null> {
  return withMemoryLock(workspace, async () => {
    const capsules = await loadCapsules(workspace);
    const index = capsules.findIndex((capsule) => capsule.id === idOrPrefix || capsule.id.startsWith(idOrPrefix));
    if (index < 0) return null;
    const now = new Date().toISOString();
    const current = capsules[index];
    const next: Capsule = {
      ...current,
      useCount: countValue(current.useCount + 1),
      updatedAt: now
    };
    capsules[index] = next;
    await writeJsonl(memoryPath(workspace), capsules);
    await debug("capsule.use_count_updated", { id: next.id, title: next.title, useCount: next.useCount }, workspace);
    return next;
  });
}

export async function updateCapsuleDerivedData(
  id: string,
  patch: Partial<Pick<Capsule, "embedding" | "graph" | "bindingSnapshots" | "staleness">>,
  workspace = workspaceRoot()
): Promise<Capsule | null> {
  return withMemoryLock(workspace, () => updateCapsuleDerivedDataUnlocked(id, patch, workspace));
}

async function updateCapsuleDerivedDataUnlocked(
  id: string,
  patch: Partial<Pick<Capsule, "embedding" | "graph" | "bindingSnapshots" | "staleness">>,
  workspace: string
): Promise<Capsule | null> {
  const capsules = await loadCapsules(workspace);
  const index = capsules.findIndex((capsule) => capsule.id === id);
  if (index < 0) return null;
  const now = new Date().toISOString();
  const current = capsules[index];
  const next: Capsule = {
    ...current,
    embedding: normalizeEmbedding(patch.embedding ?? current.embedding),
    graph: normalizeGraph(patch.graph ?? current.graph),
    bindingSnapshots: normalizeBindingSnapshots(patch.bindingSnapshots ?? current.bindingSnapshots),
    staleness: normalizeStaleness(patch.staleness ?? current.staleness),
    updatedAt: now
  };
  capsules[index] = next;
  await writeJsonl(memoryPath(workspace), capsules);
  await debug("capsule.derived_data_updated", {
    id: next.id,
    hasEmbedding: !!next.embedding,
    graphEdges: next.graph?.length ?? 0,
    bindingSnapshots: next.bindingSnapshots?.length ?? 0,
    stale: next.staleness?.stale ?? false
  }, workspace);
  return next;
}

export async function saveTraceEvents(events: ArcEvent[], sessionId: string, workspace = workspaceRoot()): Promise<string> {
  const path = tracePath(sessionId, workspace);
  const next = events.map((event) => JSON.stringify(event)).join("\n") + (events.length ? "\n" : "");
  try {
    const current = await readFile(path, "utf8");
    if (current === next) {
      await debug("trace.unchanged", { sessionId, eventCount: events.length, path }, workspace);
      return path;
    }
  } catch {
    // Missing or unreadable traces are rewritten below.
  }
  await writeJsonl(path, events);
  await debug("trace.saved", { sessionId, eventCount: events.length, path }, workspace);
  return path;
}

export async function alreadyReviewed(sessionId: string, workspace = workspaceRoot()): Promise<ReviewRecord | null> {
  const records = await readJsonl<ReviewRecord>(reviewedPath(workspace));
  return records.find((record) => record.sessionId === sessionId && record.workspace === workspace && record.status !== "failed") ?? null;
}

export async function recordReview(record: Omit<ReviewRecord, "createdAt" | "workspace">, workspace = workspaceRoot()): Promise<void> {
  await appendJsonl(reviewedPath(workspace), {
    ...record,
    workspace,
    createdAt: new Date().toISOString()
  });
}

export async function withReviewLock<T>(sessionId: string, workspace: string, fn: () => Promise<T>): Promise<T | null> {
  const lock = reviewLockPath(sessionId, workspace);
  if (!(await tryCreateLock(lock))) {
    if (await removeStaleLock(lock)) {
      await debug("review.lock_stale_removed", { sessionId }, workspace);
      if (!(await tryCreateLock(lock))) {
        await debug("review.locked", { sessionId }, workspace);
        return null;
      }
    } else {
      await debug("review.locked", { sessionId }, workspace);
      return null;
    }
  }
  await writeFile(`${lock}/pid`, `${process.pid}\n${new Date().toISOString()}\n`, "utf8");
  try {
    return await fn();
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}

async function withMemoryLock<T>(workspace: string, fn: () => Promise<T>): Promise<T> {
  const lock = memoryLockPath(workspace);
  await waitForLock(lock, workspace, "memory");
  await writeFile(`${lock}/pid`, `${process.pid}\n${new Date().toISOString()}\n`, "utf8");
  try {
    return await fn();
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}

async function waitForLock(lock: string, workspace: string, label: string): Promise<void> {
  const deadlineMs = Number(process.env.AGENT_RUN_CACHE_LOCK_WAIT_MS ?? 30_000);
  const deadline = Date.now() + (Number.isFinite(deadlineMs) && deadlineMs > 0 ? deadlineMs : 30_000);
  while (true) {
    if (await tryCreateLock(lock)) return;
    if (await removeStaleLock(lock)) {
      await debug(`${label}.lock_stale_removed`, {}, workspace);
      continue;
    }
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label} lock`);
    await delay(20 + Math.floor(Math.random() * 30));
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function tryCreateLock(lock: string): Promise<boolean> {
  try {
    await mkdir(lock, { recursive: false });
    return true;
  } catch {
    return false;
  }
}

async function removeStaleLock(lock: string): Promise<boolean> {
  const staleAfterMs = Number(process.env.AGENT_RUN_CACHE_LOCK_STALE_MS ?? 30 * 60 * 1000);
  if (!Number.isFinite(staleAfterMs) || staleAfterMs <= 0) return false;
  try {
    const info = await stat(lock);
    if (Date.now() - info.mtimeMs < staleAfterMs) return false;
    await rm(lock, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

export function traceHash(events: ArcEvent[]): string {
  const hash = createHash("sha256");
  for (const event of events) {
    hash.update(event.id);
    hash.update("\0");
    hash.update(event.rawType ?? "");
    hash.update("\0");
    hash.update(event.timestamp);
    hash.update("\0");
  }
  return hash.digest("hex");
}

function normalizeCapsule(input: Partial<Capsule>, workspace: string, now: string): Capsule {
  const workflow = normalizeWorkflow(input.workflow, workspace);
  return {
    id: input.id ?? randomUUID(),
    runner: input.runner ?? "copilot",
    workspace: input.workspace ?? workspace,
    workspaceKey: clean(input.workspaceKey) || workspaceKey(workspace),
    workspaceGroup: clean(input.workspaceGroup) || workspaceGroup(),
    sourceSessionId: input.sourceSessionId ?? "unknown",
    sourceSessionIds: cleanList(input.sourceSessionIds).length ? cleanList(input.sourceSessionIds) : cleanList([input.sourceSessionId ?? "unknown"]),
    createdAt: input.createdAt ?? now,
    updatedAt: now,
    status: normalizeStatus(input.status),
    privacyLabel: normalizePrivacyLabel(input.privacyLabel),
    contributors: cleanList(input.contributors).length ? cleanList(input.contributors) : defaultContributors(),
    useCount: countValue(input.useCount),
    successCount: countValue(input.successCount),
    failureCount: countValue(input.failureCount),
    kind: clean(input.kind) || "workflow",
    mergeKey: clean(input.mergeKey),
    title: clean(input.title) || "Reusable agent workflow",
    summary: cleanForWorkspace(input.summary, workspace),
    reusable: input.reusable ?? true,
    confidence: clamp(Number(input.confidence ?? 0.7), 0, 1),
    reuseWhen: cleanListForWorkspace(input.reuseWhen, workspace),
    doNotReuseWhen: cleanListForWorkspace(input.doNotReuseWhen, workspace),
    evidence: cleanListForWorkspace(input.evidence, workspace),
    provenance: cleanListForWorkspace(input.provenance, workspace),
    artifactSources: cleanListForWorkspace(input.artifactSources, workspace),
    supersedes: cleanList(input.supersedes),
    supersededBy: cleanList(input.supersededBy),
    confidenceReason: cleanForWorkspace(input.confidenceReason, workspace),
    failureBoundary: cleanListForWorkspace(input.failureBoundary, workspace),
    validationProvenance: cleanListForWorkspace(input.validationProvenance, workspace),
    outcomeStatus: normalizeOutcomeStatus(input.outcomeStatus),
    nextRunInstruction: cleanForWorkspace(input.nextRunInstruction || workflow.steps.join(" "), workspace),
    workflow,
    embedding: normalizeEmbedding(input.embedding),
    graph: normalizeGraph(input.graph),
    bindingSnapshots: normalizeBindingSnapshots(input.bindingSnapshots),
    staleness: normalizeStaleness(input.staleness)
  };
}

function normalizeLoadedCapsule(capsule: Capsule, workspace: string): Capsule {
  return normalizeCapsule(capsule, workspace, capsule.updatedAt || new Date().toISOString());
}

function normalizeWorkflow(input: Partial<WorkflowCapsule> | undefined, workspace: string): WorkflowCapsule {
  return {
    purpose: cleanForWorkspace(input?.purpose, workspace),
    parameters: cleanListForWorkspace(input?.parameters, workspace),
    bindingSources: cleanListForWorkspace(input?.bindingSources, workspace),
    steps: cleanListForWorkspace(input?.steps, workspace),
    commands: cleanListForWorkspace(input?.commands, workspace),
    successCriteria: cleanListForWorkspace(input?.successCriteria, workspace),
    failedAttempts: cleanListForWorkspace(input?.failedAttempts, workspace),
    validationProbe: cleanListForWorkspace(input?.validationProbe, workspace)
  };
}

function normalizeStatus(value: unknown): CapsuleStatus {
  if (value === "local" || value === "shareable" || value === "shared" || value === "rejected" || value === "superseded" || value === "private") return value;
  return "local";
}

function normalizePrivacyLabel(value: unknown): PrivacyLabel {
  if (value === "local" || value === "shareable" || value === "private" || value === "redacted") return value;
  return "local";
}

function defaultContributors(): string[] {
  const value = process.env.AGENT_RUN_CACHE_USER || process.env.USER || process.env.LOGNAME || "";
  return value ? [clean(value)] : [];
}

function countValue(value: unknown): number {
  const count = Number(value ?? 0);
  return Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
}

function clean(value: unknown): string {
  return collapseWhitespace(String(value ?? "")).slice(0, 4000);
}

function cleanForWorkspace(value: unknown, workspace: string): string {
  return portable(clean(value), workspace);
}

function cleanList(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return values.map(clean).filter(Boolean).slice(0, 24);
}

function cleanListForWorkspace(values: unknown, workspace: string): string[] {
  return cleanList(values).map((value) => portable(value, workspace));
}

function portable(value: string, workspace: string): string {
  const root = workspace.endsWith("/") ? workspace.slice(0, -1) : workspace;
  let next = value;
  if (root && root !== "/") {
    const prefix = `${root}/`;
    while (next.includes(prefix)) next = next.split(prefix).join("");
    if (next === root) next = ".";
  }
  return redactSensitive(next);
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function stableKey(capsule: Capsule): string {
  if (capsule.mergeKey) return normalizeKey(["merge", capsule.kind, capsule.mergeKey].join("\n"));
  return normalizeKey([capsule.kind, capsule.workflow.purpose, capsule.workflow.parameters.join(" "), capsule.workflow.commands.join(" ")]
    .join("\n")
  );
}

function findMergeIndex(existing: Capsule[], capsule: Capsule): number {
  const key = stableKey(capsule);
  const exact = existing.findIndex((item) => stableKey(item) === key);
  if (exact >= 0) return exact;
  return existing.findIndex((item) => canFuzzyMerge(item, capsule) && likelySameCapsule(item, capsule));
}

function compactCapsules(capsules: Capsule[]): Capsule[] {
  return compactCapsulesWithMergeRecords(capsules).capsules;
}

interface CapsuleMergeRecord {
  from: Capsule;
  to: Capsule;
  reason: string;
}

function compactCapsulesWithMergeRecords(capsules: Capsule[]): { capsules: Capsule[]; merged: CapsuleMergeRecord[] } {
  const compacted: Capsule[] = [];
  const merged: CapsuleMergeRecord[] = [];
  for (const capsule of capsules) {
    const index = findMergeIndex(compacted, capsule);
    if (index >= 0) {
      const target = compacted[index];
      compacted[index] = mergeCapsules(target, capsule, latestTimestamp(target.updatedAt, capsule.updatedAt));
      if (capsule.id !== target.id) {
        merged.push({ from: capsule, to: compacted[index], reason: "memory compaction matched an existing durable capsule" });
      }
    } else {
      compacted.push(capsule);
    }
  }
  return { capsules: compacted, merged };
}

function latestTimestamp(left: string, right: string): string {
  const leftMs = Date.parse(left) || 0;
  const rightMs = Date.parse(right) || 0;
  return rightMs > leftMs ? right : left;
}

function likelySameCapsule(left: Capsule, right: Capsule): boolean {
  const sharedCommands = overlap(left.workflow.commands, right.workflow.commands);
  const sharedBindings = overlap(left.workflow.bindingSources, right.workflow.bindingSources);
  if (sharedCommands && sharedBindings) return true;
  const identityScore = tokenSimilarity(identityText(left), identityText(right));
  if (sharedBindings && identityScore >= 0.5) return true;

  const commandOverlap = tokenOverlap(commandShapeText(left), commandShapeText(right));
  const bindingOverlap = tokenOverlap(bindingText(left), bindingText(right));
  const fingerprintOverlap = tokenOverlap(fingerprintText(left), fingerprintText(right));

  if (bindingOverlap.score >= 0.45 && fingerprintOverlap.score >= 0.55 && fingerprintOverlap.distinctiveShared >= 6) {
    return true;
  }
  if (commandOverlap.score >= 0.65 && identityScore >= 0.35 && fingerprintOverlap.distinctiveShared >= 6) {
    return true;
  }
  if (commandOverlap.score >= 0.55 && bindingOverlap.score >= 0.25 && fingerprintOverlap.distinctiveShared >= 7) {
    return true;
  }
  return false;
}

function canFuzzyMerge(left: Capsule, right: Capsule): boolean {
  const leftIdentity = explicitMergeIdentity(left);
  const rightIdentity = explicitMergeIdentity(right);
  return !leftIdentity || !rightIdentity || leftIdentity === rightIdentity;
}

function explicitMergeIdentity(capsule: Capsule): string {
  if (!capsule.mergeKey) return "";
  return normalizeKey([capsule.kind, capsule.mergeKey].join("\n"));
}

function overlap(left: string[], right: string[]): boolean {
  const values = new Set(left.map(normalizeKey).filter(Boolean));
  return right.map(normalizeKey).some((value) => values.has(value));
}

function identityText(capsule: Capsule): string {
  return [
    capsule.title,
    capsule.summary,
    capsule.workflow.purpose,
    capsule.reuseWhen.join(" "),
    capsule.workflow.steps.join(" ")
  ].join(" ");
}

function commandShapeText(capsule: Capsule): string {
  return [
    capsule.workflow.commands.join(" "),
    capsule.workflow.validationProbe.join(" "),
    capsule.workflow.failedAttempts.join(" ")
  ].join(" ");
}

function bindingText(capsule: Capsule): string {
  return [
    capsule.workflow.bindingSources.join(" "),
    capsule.provenance.join(" "),
    capsule.artifactSources.join(" ")
  ].join(" ");
}

function fingerprintText(capsule: Capsule): string {
  return [
    capsule.kind,
    capsule.mergeKey,
    capsule.title,
    capsule.summary,
    capsule.nextRunInstruction,
    capsule.reuseWhen.join(" "),
    capsule.doNotReuseWhen.join(" "),
    capsule.workflow.purpose,
    capsule.workflow.parameters.join(" "),
    capsule.workflow.bindingSources.join(" "),
    capsule.workflow.steps.join(" "),
    capsule.workflow.commands.join(" "),
    capsule.workflow.successCriteria.join(" "),
    capsule.workflow.failedAttempts.join(" "),
    capsule.workflow.validationProbe.join(" ")
  ].join(" ");
}

function tokenOverlap(left: string, right: string): { score: number; distinctiveShared: number } {
  const leftTokens = tokens(left);
  const rightTokens = tokens(right);
  if (!leftTokens.length || !rightTokens.length) return { score: 0, distinctiveShared: 0 };
  const rightSet = new Set(rightTokens);
  const shared = leftTokens.filter((token) => rightSet.has(token));
  return {
    score: shared.length / Math.min(leftTokens.length, rightTokens.length),
    distinctiveShared: shared.filter(isDistinctiveToken).length
  };
}

function tokenSimilarity(left: string, right: string): number {
  return tokenOverlap(left, right).score;
}

function tokens(value: string): string[] {
  return unique(
    normalizeKey(value)
      .split(/[^a-z0-9_./:-]+/)
      .flatMap(tokenVariants)
      .filter((part) => part.length >= 3)
  );
}

function tokenVariants(part: string): string[] {
  const cleanPart = part.replace(/^[^a-z0-9_]+|[^a-z0-9_]+$/g, "");
  if (!cleanPart) return [];
  const values = [cleanPart];
  const basename = cleanPart.split("/").filter(Boolean).at(-1);
  if (basename && basename !== cleanPart) values.push(basename);
  for (const piece of cleanPart.split(/[./:-]+/)) {
    if (piece) values.push(piece);
  }
  return values.map(normalizeWorkflowToken).filter(Boolean);
}

function normalizeWorkflowToken(value: string): string {
  const token = value.replace(/^[^a-z0-9_]+|[^a-z0-9_]+$/g, "");
  if (!token) return "";
  if (token === "knownhosts") return "known_hosts";
  if (token === "userknownhostsfile") return "known_hosts";
  return token;
}

function isDistinctiveToken(token: string): boolean {
  const generic = new Set([
    "and", "ask", "asks", "before", "binding", "bindings", "capsule", "check", "checked", "command", "commands",
    "config", "configuration", "current", "file", "files", "future", "local", "method", "next", "path", "probe",
    "prompt", "resolve", "resolved", "reusable", "route", "run", "runner", "runs", "session", "source", "sources",
    "step", "steps", "target", "targets", "test", "testing", "use", "used", "user", "value", "values", "verify",
    "verified", "workflow"
  ]);
  if (generic.has(token)) return false;
  if (/^\d+$/.test(token)) return false;
  if (token.length < 4 && token !== "ssh") return false;
  return true;
}

function normalizeKey(value: string): string {
  return collapseWhitespace(value.toLowerCase());
}

function mergeCapsules(existing: Capsule, incoming: Capsule, now: string): Capsule {
  const coherentCore = coherentCoreUpdate(existing, incoming);
  return {
    ...existing,
    updatedAt: now,
    workspaceKey: existing.workspaceKey || incoming.workspaceKey,
    workspaceGroup: existing.workspaceGroup || incoming.workspaceGroup,
    status: mergeStatus(existing.status, incoming.status),
    privacyLabel: mergePrivacyLabel(existing.privacyLabel, incoming.privacyLabel),
    contributors: unique([...existing.contributors, ...incoming.contributors]),
    useCount: Math.max(existing.useCount, incoming.useCount),
    successCount: Math.max(existing.successCount, incoming.successCount),
    failureCount: Math.max(existing.failureCount, incoming.failureCount),
    sourceSessionId: incoming.sourceSessionId,
    sourceSessionIds: unique([...existing.sourceSessionIds, existing.sourceSessionId, ...incoming.sourceSessionIds, incoming.sourceSessionId]),
    kind: mergeKind(existing.kind, incoming.kind),
    mergeKey: existing.mergeKey || incoming.mergeKey,
    title: coherentCore ? preferLonger(existing.title, incoming.title) : existing.title,
    summary: coherentCore ? preferLonger(existing.summary, incoming.summary) : existing.summary,
    reusable: existing.reusable || incoming.reusable,
    confidence: Math.max(existing.confidence, incoming.confidence),
    reuseWhen: unique([...existing.reuseWhen, ...incoming.reuseWhen]).slice(0, 24),
    doNotReuseWhen: unique([...existing.doNotReuseWhen, ...incoming.doNotReuseWhen]).slice(0, 24),
    evidence: unique([...existing.evidence, ...incoming.evidence]).slice(0, 32),
    provenance: unique([...existing.provenance, ...incoming.provenance]).slice(0, 32),
    artifactSources: unique([...existing.artifactSources, ...incoming.artifactSources]).slice(0, 24),
    supersedes: unique([...existing.supersedes, ...incoming.supersedes]).slice(0, 24),
    supersededBy: unique([...existing.supersededBy, ...incoming.supersededBy]).slice(0, 24),
    confidenceReason: preferLonger(existing.confidenceReason, incoming.confidenceReason),
    failureBoundary: unique([...existing.failureBoundary, ...incoming.failureBoundary]).slice(0, 24),
    validationProvenance: unique([...existing.validationProvenance, ...incoming.validationProvenance]).slice(0, 24),
    outcomeStatus: preferOutcome(existing.outcomeStatus, incoming.outcomeStatus),
    nextRunInstruction: coherentCore ? preferLonger(existing.nextRunInstruction, incoming.nextRunInstruction) : existing.nextRunInstruction,
    workflow: mergeWorkflows(existing.workflow, incoming.workflow, coherentCore),
    embedding: incoming.embedding ?? existing.embedding,
    graph: mergeGraph(existing.graph, incoming.graph),
    bindingSnapshots: incoming.bindingSnapshots?.length ? incoming.bindingSnapshots : existing.bindingSnapshots,
    staleness: incoming.staleness ?? existing.staleness
  };
}

function coherentCoreUpdate(existing: Capsule, incoming: Capsule): boolean {
  const overlap = tokenOverlap(coreIdentityText(existing), coreIdentityText(incoming));
  const commandOverlap = tokenOverlap(commandShapeText(existing), commandShapeText(incoming));
  return (overlap.score >= 0.45 && overlap.distinctiveShared >= 4) || commandOverlap.score >= 0.65;
}

function coreIdentityText(capsule: Capsule): string {
  return [
    capsule.title,
    capsule.summary,
    capsule.nextRunInstruction,
    capsule.workflow.purpose,
    capsule.workflow.commands.join(" ")
  ].join(" ");
}

function mergeKind(left: string, right: string): string {
  const normalizedLeft = left.toLowerCase();
  const normalizedRight = right.toLowerCase();
  if (normalizedLeft === "workflow" || normalizedRight === "workflow") return "workflow";
  if (normalizedLeft === "command" || normalizedRight === "command") return "command";
  return right || left;
}

function mergeStatus(left: CapsuleStatus, right: CapsuleStatus): CapsuleStatus {
  const rank: Record<CapsuleStatus, number> = {
    rejected: 0,
    superseded: 1,
    private: 2,
    local: 3,
    shareable: 4,
    shared: 5
  };
  return rank[right] > rank[left] ? right : left;
}

function mergePrivacyLabel(left: PrivacyLabel, right: PrivacyLabel): PrivacyLabel {
  if (left === "private" || right === "private") return "private";
  if (left === "redacted" || right === "redacted") return "redacted";
  if (left === "shareable" || right === "shareable") return "shareable";
  return "local";
}

function mergeWorkflows(existing: WorkflowCapsule, incoming: WorkflowCapsule, coherentCore = true): WorkflowCapsule {
  return {
    purpose: coherentCore ? preferLonger(existing.purpose, incoming.purpose) : existing.purpose,
    parameters: unique([...existing.parameters, ...incoming.parameters]).slice(0, 24),
    bindingSources: unique([...existing.bindingSources, ...incoming.bindingSources]).slice(0, 24),
    steps: unique([...existing.steps, ...incoming.steps]).slice(0, 24),
    commands: unique([...existing.commands, ...incoming.commands]).slice(0, 16),
    successCriteria: unique([...existing.successCriteria, ...incoming.successCriteria]).slice(0, 24),
    failedAttempts: unique([...existing.failedAttempts, ...incoming.failedAttempts]).slice(0, 24),
    validationProbe: unique([...existing.validationProbe, ...incoming.validationProbe]).slice(0, 12)
  };
}

function mergeGraph(left: CapsuleGraphEdge[] | undefined, right: CapsuleGraphEdge[] | undefined): CapsuleGraphEdge[] | undefined {
  const values = [...(left ?? []), ...(right ?? [])];
  if (!values.length) return undefined;
  const seen = new Set<string>();
  const merged: CapsuleGraphEdge[] = [];
  for (const edge of values.sort((a, b) => (b.score ?? 0) - (a.score ?? 0))) {
    const key = `${edge.kind}:${edge.to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(edge);
  }
  return merged.slice(0, 24);
}

function applySupersession(capsules: Capsule[], superseding: Capsule): string[] {
  const refs = new Set(superseding.supersedes.map(normalizeKey).filter(Boolean));
  if (!refs.size) return [];
  const superseded: string[] = [];
  for (const capsule of capsules) {
    if (capsule.id === superseding.id) continue;
    const candidates = [capsule.id, capsule.mergeKey, capsule.title].map(normalizeKey).filter(Boolean);
    if (!candidates.some((candidate) => refs.has(candidate))) continue;
    capsule.supersededBy = unique([...capsule.supersededBy, superseding.id]).slice(0, 24);
    capsule.reusable = capsule.kind.toLowerCase().includes("fact") ? capsule.reusable : false;
    capsule.status = "superseded";
    superseded.push(capsule.id);
  }
  return superseded;
}

function preferLonger(left: string, right: string): string {
  if (!left) return right;
  if (!right) return left;
  return right.length > left.length * 1.25 ? right : left;
}

function unique(values: string[]): string[] {
  return [...new Set(values.map(clean).filter(Boolean))];
}

function collapseWhitespace(value: string): string {
  const out: string[] = [];
  let spacing = false;
  for (const char of value.trim()) {
    if (char === " " || char === "\n" || char === "\r" || char === "\t" || char === "\f" || char === "\v") {
      spacing = true;
      continue;
    }
    if (spacing && out.length) out.push(" ");
    spacing = false;
    out.push(char);
  }
  return out.join("");
}

function isCapsule(value: unknown): value is Capsule {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  const workflow = record.workflow as Record<string, unknown> | undefined;
  const valid = (
    typeof record.title === "string" &&
    typeof record.summary === "string" &&
    typeof record.nextRunInstruction === "string" &&
    !!workflow &&
    typeof workflow.purpose === "string" &&
    Array.isArray(workflow.steps)
  );
  if (!valid) return false;
  if (!Array.isArray(record.sourceSessionIds)) record.sourceSessionIds = typeof record.sourceSessionId === "string" ? [record.sourceSessionId] : [];
  if (typeof record.kind !== "string") record.kind = "workflow";
  if (typeof record.mergeKey !== "string") record.mergeKey = "";
  if (!Array.isArray(record.artifactSources)) record.artifactSources = [];
  if (!Array.isArray(record.supersedes)) record.supersedes = [];
  if (!Array.isArray(record.supersededBy)) record.supersededBy = [];
  if (typeof record.confidenceReason !== "string") record.confidenceReason = "";
  if (!Array.isArray(record.failureBoundary)) record.failureBoundary = [];
  if (!Array.isArray(record.validationProvenance)) record.validationProvenance = [];
  if (typeof record.outcomeStatus !== "string") record.outcomeStatus = "unknown";
  if (!Array.isArray(record.graph)) record.graph = [];
  if (!Array.isArray(record.bindingSnapshots)) record.bindingSnapshots = [];
  return true;
}

function normalizeEmbedding(value: CapsuleEmbedding | undefined): CapsuleEmbedding | undefined {
  if (!value || typeof value !== "object") return undefined;
  const vector = Array.isArray(value.vector)
    ? value.vector.map((item) => Number(item)).filter((item) => Number.isFinite(item))
    : [];
  if (!vector.length) return undefined;
  const model = clean(value.model);
  const textHash = clean(value.textHash);
  if (!model || !textHash) return undefined;
  return {
    model,
    textHash,
    vector: vector.slice(0, 8192),
    createdAt: clean(value.createdAt) || new Date().toISOString()
  };
}

function normalizeGraph(value: CapsuleGraphEdge[] | undefined): CapsuleGraphEdge[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const graph: CapsuleGraphEdge[] = [];
  for (const edge of value) {
    const kind = edge?.kind === "duplicate" || edge?.kind === "supersedes" ? edge.kind : edge?.kind === "similar" ? "similar" : null;
    const to = clean(edge?.to);
    if (!kind || !to) continue;
    const score = Number(edge?.score);
    graph.push({
      to,
      kind,
      score: Number.isFinite(score) ? clamp(score, -1, 1) : undefined,
      reason: clean(edge?.reason),
      createdAt: clean(edge?.createdAt) || new Date().toISOString()
    });
  }
  graph.splice(24);
  return graph.length ? graph : undefined;
}

function normalizeBindingSnapshots(value: BindingSourceSnapshot[] | undefined): BindingSourceSnapshot[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const snapshots: BindingSourceSnapshot[] = [];
  for (const snapshot of value) {
    const source = clean(snapshot?.source);
    if (!source) continue;
    snapshots.push({
      source,
      exists: snapshot?.exists === true,
      hash: clean(snapshot?.hash),
      capturedAt: clean(snapshot?.capturedAt) || new Date().toISOString()
    });
  }
  snapshots.splice(24);
  return snapshots.length ? snapshots : undefined;
}

function normalizeStaleness(value: CapsuleStaleness | undefined): CapsuleStaleness | undefined {
  if (!value || typeof value !== "object") return undefined;
  return {
    stale: value.stale === true,
    checkedAt: clean(value.checkedAt) || new Date().toISOString(),
    reasons: cleanList(value.reasons).slice(0, 12)
  };
}

function redactSensitive(value: string): string {
  return redactSensitiveText(value);
}

function normalizeOutcomeStatus(value: unknown): EvidenceOutcomeStatus {
  if (value === "success" || value === "partial" || value === "failed" || value === "aborted" || value === "unknown") return value;
  return "unknown";
}

function preferOutcome(left: EvidenceOutcomeStatus, right: EvidenceOutcomeStatus): EvidenceOutcomeStatus {
  const rank: Record<EvidenceOutcomeStatus, number> = {
    success: 5,
    partial: 4,
    unknown: 3,
    failed: 2,
    aborted: 1
  };
  return rank[right] < rank[left] ? right : left;
}
