import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";

import { appendJsonl, readJsonl } from "./json.js";
import { judgeDecisionsPath, retrievalReputationPath, workspaceRoot } from "./paths.js";

export interface JudgeDecisionRecord {
  id: string;
  timestamp: string;
  workspace: string;
  sessionId?: string;
  promptHash: string;
  mode: "embedding-only" | "provider-judge";
  model?: { provider: "copilot" | "ollama"; id: string };
  candidates: { capsuleId: string; score: number; reputation?: number }[];
  verdict: { inject?: string; abstain?: boolean; confidence?: number; reason?: string };
  outcome?: { injected?: boolean; used?: "unknown" | "yes" | "no"; helped?: "unknown" | "yes" | "no" };
  outcomeReason?: string;
}

interface CapsuleReputation {
  capsuleId: string;
  score: number;
  retrieved: number;
  accepted: number;
  rejected: number;
  helped: number;
  pendingRejectPromptHashes: string[];
  updatedAt: string;
}

interface ReputationFile {
  version: 1;
  capsules: Record<string, CapsuleReputation>;
}

export async function loadRetrievalReputation(workspace = workspaceRoot()): Promise<Map<string, number>> {
  const state = await readReputation(workspace);
  const result = new Map<string, number>();
  for (const item of Object.values(state.capsules)) {
    const decayed = decayScore(item);
    result.set(item.capsuleId, multiplierForScore(decayed));
  }
  return result;
}

export async function recordJudgeDecision(input: Omit<JudgeDecisionRecord, "id" | "timestamp" | "workspace" | "promptHash"> & {
  workspace?: string;
  prompt: string;
}): Promise<JudgeDecisionRecord> {
  const workspace = input.workspace ?? workspaceRoot();
  const record: JudgeDecisionRecord = {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
    timestamp: new Date().toISOString(),
    workspace,
    sessionId: input.sessionId,
    promptHash: hashPrompt(input.prompt),
    mode: input.mode,
    model: input.model,
    candidates: input.candidates,
    verdict: input.verdict,
    outcome: input.outcome
  };
  await appendJsonl(judgeDecisionsPath(workspace), record);
  await updateReputation(record, workspace);
  return record;
}

export async function recordJudgeOutcome(input: {
  workspace?: string;
  sessionId?: string;
  decisionIds?: string[];
  injectedCapsuleIds?: string[];
  outcome: NonNullable<JudgeDecisionRecord["outcome"]>;
  reason?: string;
}): Promise<JudgeDecisionRecord[]> {
  const workspace = input.workspace ?? workspaceRoot();
  const ids = new Set((input.decisionIds ?? []).filter(Boolean));
  const injected = new Set((input.injectedCapsuleIds ?? []).filter(Boolean));
  const hasIds = ids.size > 0;
  const hasSession = !!input.sessionId;
  const decisions = await loadJudgeDecisions(workspace, 1000);
  const matched = decisions
    .filter((decision) => {
      if (ids.has(decision.id)) return true;
      if (hasIds) return false;
      if (hasSession) return decision.sessionId === input.sessionId;
      if (decision.verdict.inject && injected.has(decision.verdict.inject)) return true;
      return false;
    })
    .filter((decision) => decision.mode === "provider-judge")
    .filter((decision) => hasUnknownOutcome(decision.outcome))
    .slice(-20);
  const updated: JudgeDecisionRecord[] = [];
  for (const decision of matched) {
    const next: JudgeDecisionRecord = {
      ...decision,
      timestamp: new Date().toISOString(),
      outcome: {
        ...decision.outcome,
        injected: input.outcome.injected ?? decision.outcome?.injected ?? Boolean(decision.verdict.inject),
        used: input.outcome.used ?? decision.outcome?.used,
        helped: input.outcome.helped ?? decision.outcome?.helped
      },
      outcomeReason: input.reason
    };
    await appendJsonl(judgeDecisionsPath(workspace), next);
    await updateReputationFromOutcome(next, workspace);
    updated.push(next);
  }
  return updated;
}

export async function loadJudgeDecisions(workspace = workspaceRoot(), limit = 200): Promise<JudgeDecisionRecord[]> {
  const rows = (await readJsonl<unknown>(judgeDecisionsPath(workspace))).filter(isJudgeDecision);
  const byId = new Map<string, JudgeDecisionRecord>();
  for (const row of rows) {
    const previous = byId.get(row.id);
    byId.set(row.id, mergeDecisionRecord(previous, row));
  }
  return [...byId.values()].slice(-limit);
}

async function updateReputation(record: JudgeDecisionRecord, workspace: string): Promise<void> {
  const state = await readReputation(workspace);
  const injected = record.verdict.inject;
  for (const candidate of record.candidates) {
    const item = state.capsules[candidate.capsuleId] ?? freshReputation(candidate.capsuleId);
    item.score = decayScore(item);
    item.retrieved += 1;
    item.score += 0.08;
    if (candidate.capsuleId === injected) {
      item.accepted += 1;
      item.score += 0.35 * confidence(record);
      item.pendingRejectPromptHashes = [];
    } else if (record.verdict.abstain || injected) {
      const prompts = new Set(item.pendingRejectPromptHashes);
      prompts.add(record.promptHash);
      item.pendingRejectPromptHashes = [...prompts].slice(-8);
      if (item.pendingRejectPromptHashes.length >= 2) {
        item.rejected += 1;
        item.score -= 0.2 * confidence(record);
      }
    }
    if (record.outcome?.helped === "yes" && candidate.capsuleId === injected) {
      item.helped += 1;
      item.score += 0.6;
    }
    if (record.outcome?.helped === "no" && candidate.capsuleId === injected) {
      item.score -= 0.5;
    }
    item.score = clamp(item.score, -3, 3);
    item.updatedAt = record.timestamp;
    state.capsules[candidate.capsuleId] = item;
  }
  await writeFile(retrievalReputationPath(workspace), `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

async function updateReputationFromOutcome(record: JudgeDecisionRecord, workspace: string): Promise<void> {
  const capsuleId = record.verdict.inject;
  if (!capsuleId) return;
  const state = await readReputation(workspace);
  const item = state.capsules[capsuleId] ?? freshReputation(capsuleId);
  item.score = decayScore(item);
  if (record.outcome?.used === "yes") item.score += 0.25;
  if (record.outcome?.used === "no") item.score -= 0.2;
  if (record.outcome?.helped === "yes") {
    item.helped += 1;
    item.score += 0.6;
  }
  if (record.outcome?.helped === "no") item.score -= 0.5;
  item.score = clamp(item.score, -3, 3);
  item.updatedAt = record.timestamp;
  state.capsules[capsuleId] = item;
  await writeFile(retrievalReputationPath(workspace), `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function mergeDecisionRecord(previous: JudgeDecisionRecord | undefined, next: JudgeDecisionRecord): JudgeDecisionRecord {
  if (!previous) return next;
  return {
    ...previous,
    ...next,
    candidates: next.candidates.length ? next.candidates : previous.candidates,
    verdict: Object.keys(next.verdict).length ? next.verdict : previous.verdict,
    outcome: {
      ...previous.outcome,
      ...next.outcome
    }
  };
}

function hasUnknownOutcome(outcome: JudgeDecisionRecord["outcome"]): boolean {
  if (!outcome) return true;
  return outcome.used === undefined || outcome.used === "unknown" || outcome.helped === undefined || outcome.helped === "unknown";
}

async function readReputation(workspace: string): Promise<ReputationFile> {
  const path = retrievalReputationPath(workspace);
  if (!existsSync(path)) return { version: 1, capsules: {} };
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<ReputationFile>;
    return { version: 1, capsules: parsed.capsules && typeof parsed.capsules === "object" ? parsed.capsules : {} };
  } catch {
    return { version: 1, capsules: {} };
  }
}

function freshReputation(capsuleId: string): CapsuleReputation {
  return {
    capsuleId,
    score: 0,
    retrieved: 0,
    accepted: 0,
    rejected: 0,
    helped: 0,
    pendingRejectPromptHashes: [],
    updatedAt: new Date().toISOString()
  };
}

function decayScore(item: CapsuleReputation): number {
  const updated = Date.parse(item.updatedAt);
  if (!Number.isFinite(updated)) return item.score;
  const halfLifeMs = reputationHalfLifeDays() * 24 * 60 * 60 * 1000;
  const age = Math.max(0, Date.now() - updated);
  return item.score * Math.pow(0.5, age / halfLifeMs);
}

function multiplierForScore(score: number): number {
  return clamp(1 + score * 0.08, 0.75, 1.25);
}

function reputationHalfLifeDays(): number {
  const value = Number(process.env.AGENT_RUN_CACHE_REPUTATION_HALF_LIFE_DAYS ?? 30);
  return Number.isFinite(value) && value > 0 ? value : 30;
}

function confidence(record: JudgeDecisionRecord): number {
  const value = record.verdict.confidence;
  return typeof value === "number" && Number.isFinite(value) ? clamp(value, 0, 1) : 0.5;
}

function isJudgeDecision(value: unknown): value is JudgeDecisionRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.id === "string" && typeof record.timestamp === "string" && Array.isArray(record.candidates);
}

function hashPrompt(prompt: string): string {
  return createHash("sha256").update(prompt.trim().toLowerCase()).digest("hex").slice(0, 24);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
