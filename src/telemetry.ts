import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { appendJsonl, readJsonl } from "./json.js";
import { loadMemoryEvents } from "./ledger.js";
import { cacheDir, telemetryPath, telemetryPolicyPath, workspaceRoot } from "./paths.js";
import { redactSensitiveText } from "./redact.js";
import type { ArcEvent } from "./types.js";

export type MeasurementSource = "provider" | "estimate" | "unknown";

export interface TokenMeasurement {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  source: MeasurementSource;
  scope: "turn" | "session";
}

export interface CostMeasurement {
  amount: number | null;
  currency: string;
  source: MeasurementSource;
  scope: "turn" | "session";
}

export interface ToolCallTelemetry {
  callId: string;
  operationFingerprint: string;
  name: string;
  startedAt: string;
  durationMs: number | null;
  status: "success" | "failed" | "unknown";
  attempt: number;
  retry: boolean;
}

export interface PolicyWarning {
  code: "cost" | "slow_tool" | "repeated_failures" | "excessive_retries" | "reviewer_hard_limit";
  message: string;
  observed: number;
  limit: number;
}

export interface RunTelemetryRecord {
  schemaVersion: 1;
  kind: "run";
  recordedAt: string;
  runner: string;
  sessionId: string;
  turnId: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  status: "success" | "failed" | "cancelled" | "unknown";
  stopReason: string;
  modelLatency: { firstResponseMs: number | null; totalMs: number; source: "observed" };
  tokens: TokenMeasurement;
  cost: CostMeasurement;
  toolCalls: ToolCallTelemetry[];
  failedToolCount: number;
  retryCount: number;
  retrieval: {
    decision: "injected" | "abstained" | "unknown";
    source: string;
    capsuleId?: string;
    reason: string;
    weakMatchCase: boolean;
    weakMatchAbstention: boolean;
    capsuleWasStale: boolean;
    staleCapsuleRejected: boolean;
  };
  warnings: PolicyWarning[];
}

export interface ReviewerCallTelemetryRecord {
  schemaVersion: 1;
  kind: "reviewer_call";
  recordedAt: string;
  runner: "arc-reviewer";
  sessionId: string;
  callId: string;
  source: string;
  durationMs: number;
  status: "success" | "failed" | "blocked";
  tokens: TokenMeasurement;
  cost: CostMeasurement;
  reason?: string;
  warnings: PolicyWarning[];
}

export type TelemetryRecord = RunTelemetryRecord | ReviewerCallTelemetryRecord;

export interface TelemetryPolicy {
  warnings: {
    costUsdPerSession: number | null;
    slowToolMs: number | null;
    repeatedFailures: number | null;
    retriesPerSession: number | null;
  };
  reviewer: {
    maxCallsPerSession: number | null;
    hardCostUsdPerSession: number | null;
    estimatedCostUsdPerCall: number | null;
  };
}

export interface MetricsReport {
  generatedAt: string;
  workspace: string;
  policy: TelemetryPolicy & { path: string };
  summary: {
    sessionCount: number;
    turnCount: number;
    latencyMs: {
      session: Percentiles;
      modelFirstResponse: Percentiles;
      tool: Percentiles;
      reviewer: Percentiles;
    };
    toolCalls: number;
    failedTools: number;
    failedToolRate: number;
    retries: number;
    tokens: { total: number; provider: number; estimated: number; unknownSessions: number };
    cost: { knownUsd: number; providerUsd: number; estimatedUsd: number; unknownSessions: number };
    warnings: number;
    warningMessages: string[];
  };
  sessions: SessionMetrics[];
  evaluations: ReplayEvaluationReport;
}

export interface ReplayEvaluationReport {
  generatedAt: string;
  traceCount: number;
  pairedRunCount: number;
  retrievalPrecision: { value: number | null; relevant: number; evaluated: number; injected: number; method: string };
  weakMatchAbstention: { value: number | null; abstained: number; weakMatchCases: number };
  staleCapsuleRejection: { value: number | null; rejected: number; staleCases: number };
  telemetryRedaction: { passed: boolean; recordsScanned: number; violations: number };
  injectedMemoryOutcome: { helped: number; didNotHelp: number; inconclusive: number; method: string };
}

interface Percentiles { count: number; p50: number | null; p95: number | null; p99: number | null }
interface SessionMetrics {
  sessionId: string; startedAt: string; endedAt: string; durationMs: number; status: string; turns: number;
  toolCalls: number; failedTools: number; failedToolRate: number; retries: number; modelFirstResponseMs: number | null;
  tokens: { total: number | null; source: MeasurementSource | "mixed" };
  cost: { usd: number | null; source: MeasurementSource | "mixed" };
  reviewerCalls: number; warningCount: number;
}

const DEFAULT_POLICY: TelemetryPolicy = {
  warnings: { costUsdPerSession: null, slowToolMs: 30_000, repeatedFailures: 2, retriesPerSession: 3 },
  reviewer: { maxCallsPerSession: null, hardCostUsdPerSession: null, estimatedCostUsdPerCall: null }
};

export async function recordRunFromEvents(events: ArcEvent[], workspace = workspaceRoot(), sessionId = events[0]?.sessionId ?? "unknown"): Promise<void> {
  if (!events.length) return;
  const records = await loadTelemetryRecords(workspace);
  if (records.some((record) => record.kind === "run" && record.sessionId === sessionId)) return;
  const timestamps = events.map((event) => Date.parse(event.timestamp)).filter(Number.isFinite);
  const startedAtMs = timestamps.length ? Math.min(...timestamps) : Date.now();
  const endedAtMs = timestamps.length ? Math.max(...timestamps) : startedAtMs;
  const promptAt = events.filter((event) => event.type === "user_prompt").map((event) => Date.parse(event.timestamp)).find(Number.isFinite) ?? startedAtMs;
  const firstResponse = events.filter((event) => event.type === "assistant_message" || event.type === "tool_start")
    .map((event) => Date.parse(event.timestamp)).find((value) => Number.isFinite(value) && value >= promptAt);
  const toolCalls = toolTelemetry(events, sessionId);
  const failedToolCount = toolCalls.filter((tool) => tool.status === "failed").length;
  const retryCount = toolCalls.filter((tool) => tool.retry).length;
  const [status, stopReason] = runOutcome(events, failedToolCount);
  const record: RunTelemetryRecord = {
    schemaVersion: 1,
    kind: "run",
    recordedAt: new Date().toISOString(),
    runner: sanitizeLabel(events[0]?.runner ?? "copilot", 40),
    sessionId: sanitizeLabel(sessionId, 200),
    turnId: sanitizeLabel(sessionId, 240),
    startedAt: new Date(startedAtMs).toISOString(),
    endedAt: new Date(endedAtMs).toISOString(),
    durationMs: Math.max(0, endedAtMs - startedAtMs),
    status,
    stopReason,
    modelLatency: {
      firstResponseMs: firstResponse === undefined ? null : Math.max(0, firstResponse - promptAt),
      totalMs: Math.max(0, endedAtMs - promptAt),
      source: "observed"
    },
    tokens: providerTokens(events) ?? estimatedTokens(events),
    cost: providerCost(events) ?? unknownCost("session"),
    toolCalls,
    failedToolCount,
    retryCount,
    retrieval: await retrievalForSession(workspace, sessionId),
    warnings: []
  };
  record.warnings = runWarnings(record, await loadTelemetryPolicy(workspace));
  await appendJsonl(telemetryPath(workspace), record);
}

export async function loadTelemetryRecords(workspace = workspaceRoot()): Promise<TelemetryRecord[]> {
  return (await readJsonl<unknown>(telemetryPath(workspace))).filter(isTelemetryRecord);
}

export async function loadTelemetryPolicy(workspace = workspaceRoot()): Promise<TelemetryPolicy> {
  const file = await readFile(telemetryPolicyPath(workspace), "utf8").then(JSON.parse).catch(() => ({})) as Record<string, unknown>;
  const warnings = isRecord(file.warnings) ? file.warnings : {};
  const reviewer = isRecord(file.reviewer) ? file.reviewer : {};
  return {
    warnings: {
      costUsdPerSession: configuredNumber(warnings.costUsdPerSession, "AGENT_RUN_CACHE_WARN_COST_USD", DEFAULT_POLICY.warnings.costUsdPerSession),
      slowToolMs: configuredNumber(warnings.slowToolMs, "AGENT_RUN_CACHE_WARN_SLOW_TOOL_MS", DEFAULT_POLICY.warnings.slowToolMs),
      repeatedFailures: configuredNumber(warnings.repeatedFailures, "AGENT_RUN_CACHE_WARN_REPEATED_FAILURES", DEFAULT_POLICY.warnings.repeatedFailures),
      retriesPerSession: configuredNumber(warnings.retriesPerSession, "AGENT_RUN_CACHE_WARN_RETRIES", DEFAULT_POLICY.warnings.retriesPerSession)
    },
    reviewer: {
      maxCallsPerSession: configuredNumber(reviewer.maxCallsPerSession, "AGENT_RUN_CACHE_REVIEWER_MAX_CALLS", DEFAULT_POLICY.reviewer.maxCallsPerSession),
      hardCostUsdPerSession: configuredNumber(reviewer.hardCostUsdPerSession, "AGENT_RUN_CACHE_REVIEWER_HARD_COST_USD", DEFAULT_POLICY.reviewer.hardCostUsdPerSession),
      estimatedCostUsdPerCall: configuredNumber(reviewer.estimatedCostUsdPerCall, "AGENT_RUN_CACHE_REVIEWER_ESTIMATED_COST_USD_PER_CALL", DEFAULT_POLICY.reviewer.estimatedCostUsdPerCall)
    }
  };
}

export async function reviewerBudgetReason(workspace: string, sessionId: string): Promise<string | null> {
  const policy = await loadTelemetryPolicy(workspace);
  const calls = (await loadTelemetryRecords(workspace)).filter((record): record is ReviewerCallTelemetryRecord => record.kind === "reviewer_call" && record.sessionId === sessionId && record.status !== "blocked");
  if (policy.reviewer.maxCallsPerSession !== null && calls.length >= policy.reviewer.maxCallsPerSession) {
    const reason = `ARC reviewer hard call limit reached (${calls.length}/${policy.reviewer.maxCallsPerSession}).`;
    await recordBlockedReviewer(workspace, sessionId, reason, calls.length, policy.reviewer.maxCallsPerSession);
    return reason;
  }
  const cost = calls.reduce((sum, call) => sum + (call.cost.amount ?? 0), 0);
  const next = policy.reviewer.estimatedCostUsdPerCall ?? 0;
  if (policy.reviewer.hardCostUsdPerSession !== null && cost + next >= policy.reviewer.hardCostUsdPerSession) {
    const reason = `ARC reviewer hard cost limit reached ($${(cost + next).toFixed(4)}/$${policy.reviewer.hardCostUsdPerSession.toFixed(4)}).`;
    await recordBlockedReviewer(workspace, sessionId, reason, cost + next, policy.reviewer.hardCostUsdPerSession);
    return reason;
  }
  return null;
}

export async function recordReviewerCall(input: {
  workspace: string; sessionId: string; source: string; durationMs: number;
  status: "success" | "failed"; input: string; output: string; reason?: string;
}): Promise<void> {
  const policy = await loadTelemetryPolicy(input.workspace);
  const record: ReviewerCallTelemetryRecord = {
    schemaVersion: 1, kind: "reviewer_call", recordedAt: new Date().toISOString(), runner: "arc-reviewer",
    sessionId: sanitizeLabel(input.sessionId, 200), callId: randomUUID(), source: sanitizeLabel(input.source, 80),
    durationMs: Math.max(0, input.durationMs), status: input.status,
    tokens: tokenMeasurement(input.input, input.output, "turn"),
    cost: policy.reviewer.estimatedCostUsdPerCall === null
      ? unknownCost("turn")
      : { amount: policy.reviewer.estimatedCostUsdPerCall, currency: "USD", source: "estimate", scope: "turn" },
    reason: input.reason ? sanitizeLabel(input.reason, 500) : undefined,
    warnings: []
  };
  if (policy.warnings.costUsdPerSession !== null && record.cost.amount !== null) {
    const before = (await loadTelemetryRecords(input.workspace)).filter((value) => value.sessionId === input.sessionId)
      .reduce((sum, value) => sum + (value.kind === "reviewer_call" && value.status === "blocked" ? 0 : value.cost.amount ?? 0), 0);
    const after = before + record.cost.amount;
    if (before < policy.warnings.costUsdPerSession && after >= policy.warnings.costUsdPerSession) {
      record.warnings.push(warning("cost", `Session cost reached $${after.toFixed(4)} (warning budget $${policy.warnings.costUsdPerSession.toFixed(4)}).`, after, policy.warnings.costUsdPerSession));
    }
  }
  await appendJsonl(telemetryPath(input.workspace), record);
}

export async function buildMetricsReport(workspace = workspaceRoot()): Promise<MetricsReport> {
  const records = await loadTelemetryRecords(workspace);
  const runs = records.filter((record): record is RunTelemetryRecord => record.kind === "run");
  const reviewers = records.filter((record): record is ReviewerCallTelemetryRecord => record.kind === "reviewer_call");
  const sessionIds = [...new Set(records.map((record) => record.sessionId))];
  const sessions = sessionIds.map((id) => sessionMetrics(id, runs, reviewers)).filter((value): value is SessionMetrics => !!value)
    .sort((left, right) => Date.parse(right.endedAt) - Date.parse(left.endedAt));
  const tools = runs.flatMap((run) => run.toolCalls);
  const completedReviewers = reviewers.filter((call) => call.status !== "blocked");
  const failedTools = tools.filter((tool) => tool.status === "failed").length;
  const providerTokensTotal = runs.filter((run) => run.tokens.source === "provider").reduce((sum, run) => sum + (run.tokens.totalTokens ?? 0), 0);
  const estimatedTokensTotal = runs.filter((run) => run.tokens.source === "estimate").reduce((sum, run) => sum + (run.tokens.totalTokens ?? 0), 0)
    + completedReviewers.reduce((sum, call) => sum + (call.tokens.totalTokens ?? 0), 0);
  const providerCostTotal = runs.filter((run) => run.cost.source === "provider").reduce((sum, run) => sum + (run.cost.amount ?? 0), 0);
  const estimatedCostTotal = [...runs, ...completedReviewers].filter((record) => record.cost.source === "estimate").reduce((sum, record) => sum + (record.cost.amount ?? 0), 0);
  const policy = await loadTelemetryPolicy(workspace);
  return {
    generatedAt: new Date().toISOString(), workspace, policy: { ...policy, path: telemetryPolicyPath(workspace) },
    summary: {
      sessionCount: sessions.length, turnCount: runs.length,
      latencyMs: {
        session: percentiles(sessions.map((session) => session.durationMs)),
        modelFirstResponse: percentiles(runs.map((run) => run.modelLatency.firstResponseMs)),
        tool: percentiles(tools.map((tool) => tool.durationMs)),
        reviewer: percentiles(completedReviewers.map((call) => call.durationMs))
      },
      toolCalls: tools.length, failedTools, failedToolRate: ratio(failedTools, tools.length), retries: runs.reduce((sum, run) => sum + run.retryCount, 0),
      tokens: { total: providerTokensTotal + estimatedTokensTotal, provider: providerTokensTotal, estimated: estimatedTokensTotal, unknownSessions: sessions.filter((session) => session.tokens.total === null).length },
      cost: { knownUsd: roundMoney(providerCostTotal + estimatedCostTotal), providerUsd: roundMoney(providerCostTotal), estimatedUsd: roundMoney(estimatedCostTotal), unknownSessions: sessions.filter((session) => session.cost.usd === null).length },
      warnings: records.reduce((sum, record) => sum + record.warnings.length, 0),
      warningMessages: records.slice().reverse().flatMap((record) => record.warnings.map((warning) => warning.message)).slice(0, 8)
    },
    sessions,
    evaluations: await runReplayEvaluations(workspace, records)
  };
}

export async function runReplayEvaluations(workspace = workspaceRoot(), supplied?: TelemetryRecord[]): Promise<ReplayEvaluationReport> {
  const records = supplied ?? await loadTelemetryRecords(workspace);
  const runs = records.filter((record): record is RunTelemetryRecord => record.kind === "run");
  const traceCount = await readdir(join(cacheDir(workspace), "traces")).then((items) => items.filter((name) => name.endsWith(".jsonl")).length).catch(() => 0);
  const injected = runs.filter((run) => run.retrieval.decision === "injected");
  const helped = injected.filter((run) => run.status === "success" && run.failedToolCount === 0 && run.retryCount === 0).length;
  const didNotHelp = injected.filter((run) => run.status === "failed").length;
  const inconclusive = injected.length - helped - didNotHelp;
  const evaluated = helped + didNotHelp;
  const weak = runs.filter((run) => run.retrieval.weakMatchCase ?? run.retrieval.weakMatchAbstention);
  const weakAbstained = weak.filter((run) => run.retrieval.decision === "abstained").length;
  const stale = runs.filter((run) => run.retrieval.capsuleWasStale || run.retrieval.staleCapsuleRejected);
  const rejected = stale.filter((run) => run.retrieval.decision === "abstained").length;
  const violations = records.filter((record) => !telemetryRecordIsRedacted(record)).length;
  return {
    generatedAt: new Date().toISOString(), traceCount, pairedRunCount: Math.min(traceCount, runs.length),
    retrievalPrecision: { value: evaluated ? helped / evaluated : null, relevant: helped, evaluated, injected: injected.length, method: "Observed proxy: an injected trace is relevant when it ends successfully without failed or retried tools; ambiguous recoveries are excluded." },
    weakMatchAbstention: { value: weak.length ? weakAbstained / weak.length : null, abstained: weakAbstained, weakMatchCases: weak.length },
    staleCapsuleRejection: { value: stale.length ? rejected / stale.length : null, rejected, staleCases: stale.length },
    telemetryRedaction: { passed: violations === 0, recordsScanned: records.length, violations },
    injectedMemoryOutcome: { helped, didNotHelp, inconclusive, method: "Deterministic trace proxy, not a causal claim: clean successful reuse counts as helped, failed runs as not helped, and recovered failures as inconclusive." }
  };
}

export async function sanitizedMetricsAggregate(workspace = workspaceRoot()): Promise<Record<string, unknown>> {
  const report = await buildMetricsReport(workspace);
  return { generatedAt: report.generatedAt, summary: report.summary, evaluations: report.evaluations, policy: { warnings: report.policy.warnings, reviewer: report.policy.reviewer } };
}

function toolTelemetry(events: ArcEvent[], sessionId: string): ToolCallTelemetry[] {
  const starts: { index: number; event: ArcEvent; fingerprint: string }[] = [];
  const completed = new Set<number>();
  const attempts = new Map<string, number>();
  const tools: ToolCallTelemetry[] = [];
  for (const event of events) {
    if (event.type === "tool_start") { starts.push({ index: starts.length, event, fingerprint: toolFingerprint(event, sessionId) }); continue; }
    if (event.type !== "tool_end") continue;
    const start = starts.find((value) => !completed.has(value.index) && !!event.toolUseId && value.event.toolUseId === event.toolUseId)
      ?? starts.find((value) => !completed.has(value.index) && !!event.command && value.event.command === event.command)
      ?? starts.find((value) => !completed.has(value.index));
    if (start) completed.add(start.index);
    const fingerprint = start?.fingerprint ?? toolFingerprint(event, sessionId);
    const attempt = (attempts.get(fingerprint) ?? 0) + 1;
    attempts.set(fingerprint, attempt);
    const startedAt = start?.event.timestamp ?? event.timestamp;
    tools.push({
      callId: hash(`${sessionId}\0${event.toolUseId ?? ""}\0${tools.length}`).slice(0, 24), operationFingerprint: fingerprint,
      name: sanitizeLabel(event.toolName ?? start?.event.toolName ?? "tool", 80), startedAt,
      durationMs: durationBetween(startedAt, event.timestamp), status: toolStatus(event), attempt, retry: attempt > 1
    });
  }
  for (const start of starts.filter((value) => !completed.has(value.index))) {
    const attempt = (attempts.get(start.fingerprint) ?? 0) + 1;
    attempts.set(start.fingerprint, attempt);
    tools.push({ callId: hash(`${sessionId}\0${start.event.toolUseId ?? ""}\0${start.index}`).slice(0, 24), operationFingerprint: start.fingerprint, name: sanitizeLabel(start.event.toolName ?? "tool", 80), startedAt: start.event.timestamp, durationMs: null, status: "unknown", attempt, retry: attempt > 1 });
  }
  return tools;
}

async function retrievalForSession(workspace: string, sessionId: string): Promise<RunTelemetryRecord["retrieval"]> {
  const event = (await loadMemoryEvents(workspace)).slice().reverse().find((value) => value.sessionId === sessionId && (value.type === "capsule.injected" || value.type === "capsule.retrieval"));
  if (!event) return { decision: "unknown", source: "unknown", reason: "no recorded retrieval decision", weakMatchCase: false, weakMatchAbstention: false, capsuleWasStale: false, staleCapsuleRejected: false };
  const decision = event.details?.decision === "abstained" ? "abstained" : event.type === "capsule.injected" ? "injected" : "abstained";
  const reason = sanitizeLabel(typeof event.details?.reason === "string" ? event.details.reason : "recorded retrieval decision", 500);
  const capsuleWasStale = event.details?.capsuleWasStale === true;
  return { decision, source: sanitizeLabel(typeof event.details?.source === "string" ? event.details.source : "unknown", 40), capsuleId: event.capsuleId, reason, weakMatchCase: weakMatchReason(reason), weakMatchAbstention: decision === "abstained" && weakMatchReason(reason), capsuleWasStale, staleCapsuleRejected: decision === "abstained" && (capsuleWasStale || staleRejectionReason(reason)) };
}

function providerTokens(events: ArcEvent[]): TokenMeasurement | null {
  let input = 0; let output = 0; let total = 0;
  let sawInput = false; let sawOutput = false; let sawTotal = false;
  for (const event of events) {
    const nextInput = findNumber(event.raw, ["inputtokens", "prompttokens", "genaiusageinputtokens"]);
    const nextOutput = findNumber(event.raw, ["outputtokens", "completiontokens", "genaiusageoutputtokens"]);
    const nextTotal = findNumber(event.raw, ["totaltokens", "genaiusagetotaltokens"]);
    if (nextInput !== null) { input += nextInput; sawInput = true; }
    if (nextOutput !== null) { output += nextOutput; sawOutput = true; }
    if (nextTotal !== null) { total += nextTotal; sawTotal = true; }
  }
  if (!sawTotal && (sawInput || sawOutput)) { total = input + output; sawTotal = true; }
  return !sawTotal ? null : { inputTokens: sawInput ? input : null, outputTokens: sawOutput ? output : null, totalTokens: total, source: "provider", scope: "session" };
}

function providerCost(events: ArcEvent[]): CostMeasurement | null {
  let amount = 0;
  let sawCost = false;
  for (const event of events) {
    const next = findNumber(event.raw, ["costusd", "totalcostusd", "genaiusagecostusd"]);
    if (next !== null) { amount += next; sawCost = true; }
  }
  return sawCost ? { amount, currency: "USD", source: "provider", scope: "session" } : null;
}

function findNumber(value: unknown, keys: string[]): number | null {
  if (Array.isArray(value)) { for (const item of value) { const found = findNumber(item, keys); if (found !== null) return found; } return null; }
  if (!isRecord(value)) return null;
  for (const [key, item] of Object.entries(value)) {
    if (keys.includes(normalizedKey(key))) { const number = typeof item === "number" ? item : typeof item === "string" ? Number(item) : NaN; if (Number.isFinite(number) && number >= 0) return number; }
  }
  for (const item of Object.values(value)) { const found = findNumber(item, keys); if (found !== null) return found; }
  return null;
}

function sessionMetrics(sessionId: string, runs: RunTelemetryRecord[], reviewers: ReviewerCallTelemetryRecord[]): SessionMetrics | null {
  const selected = runs.filter((run) => run.sessionId === sessionId);
  const calls = reviewers.filter((call) => call.sessionId === sessionId);
  if (!selected.length && !calls.length) return null;
  const starts = [...selected.map((run) => Date.parse(run.startedAt)), ...calls.map((call) => Date.parse(call.recordedAt))].filter(Number.isFinite);
  const ends = [...selected.map((run) => Date.parse(run.endedAt)), ...calls.map((call) => Date.parse(call.recordedAt))].filter(Number.isFinite);
  const start = Math.min(...starts); const end = Math.max(...ends);
  const tools = selected.flatMap((run) => run.toolCalls); const failedTools = tools.filter((tool) => tool.status === "failed").length;
  const completed = calls.filter((call) => call.status !== "blocked");
  const tokens = [...selected, ...completed].map((record) => record.tokens).filter((value) => value.totalTokens !== null);
  const costs = [...selected, ...completed].map((record) => record.cost).filter((value) => value.amount !== null);
  return {
    sessionId, startedAt: new Date(start).toISOString(), endedAt: new Date(end).toISOString(), durationMs: Math.max(0, end - start), status: selected.at(-1)?.status ?? "unknown", turns: selected.length,
    toolCalls: tools.length, failedTools, failedToolRate: ratio(failedTools, tools.length), retries: selected.reduce((sum, run) => sum + run.retryCount, 0), modelFirstResponseMs: selected.find((run) => run.modelLatency.firstResponseMs !== null)?.modelLatency.firstResponseMs ?? null,
    tokens: { total: tokens.length ? tokens.reduce((sum, value) => sum + (value.totalTokens ?? 0), 0) : null, source: mixedSource(tokens.map((value) => value.source)) },
    cost: { usd: costs.length ? roundMoney(costs.reduce((sum, value) => sum + (value.amount ?? 0), 0)) : null, source: mixedSource(costs.map((value) => value.source)) },
    reviewerCalls: completed.length, warningCount: [...selected, ...calls].reduce((sum, record) => sum + record.warnings.length, 0)
  };
}

function runWarnings(record: RunTelemetryRecord, policy: TelemetryPolicy): PolicyWarning[] {
  const warnings: PolicyWarning[] = [];
  const worst = Math.max(0, ...record.toolCalls.map((tool) => tool.durationMs ?? 0));
  if (policy.warnings.slowToolMs !== null && worst > policy.warnings.slowToolMs) warnings.push(warning("slow_tool", `A tool call exceeded the ${policy.warnings.slowToolMs}ms warning budget (worst ${worst}ms).`, worst, policy.warnings.slowToolMs));
  const failures = new Map<string, number>();
  for (const tool of record.toolCalls.filter((tool) => tool.status === "failed")) failures.set(tool.operationFingerprint, (failures.get(tool.operationFingerprint) ?? 0) + 1);
  const repeated = Math.max(0, ...failures.values());
  if (policy.warnings.repeatedFailures !== null && repeated >= policy.warnings.repeatedFailures) warnings.push(warning("repeated_failures", `A tool operation failed ${repeated} times (warning budget ${policy.warnings.repeatedFailures}).`, repeated, policy.warnings.repeatedFailures));
  if (policy.warnings.retriesPerSession !== null && record.retryCount >= policy.warnings.retriesPerSession) warnings.push(warning("excessive_retries", `Session retries reached ${record.retryCount} (warning budget ${policy.warnings.retriesPerSession}).`, record.retryCount, policy.warnings.retriesPerSession));
  if (policy.warnings.costUsdPerSession !== null && record.cost.amount !== null && record.cost.amount >= policy.warnings.costUsdPerSession) warnings.push(warning("cost", `Session cost reached $${record.cost.amount.toFixed(4)} (warning budget $${policy.warnings.costUsdPerSession.toFixed(4)}).`, record.cost.amount, policy.warnings.costUsdPerSession));
  return warnings;
}

async function recordBlockedReviewer(workspace: string, sessionId: string, reason: string, observed: number, limit: number): Promise<void> {
  const record: ReviewerCallTelemetryRecord = { schemaVersion: 1, kind: "reviewer_call", recordedAt: new Date().toISOString(), runner: "arc-reviewer", sessionId: sanitizeLabel(sessionId, 200), callId: randomUUID(), source: "policy", durationMs: 0, status: "blocked", tokens: { inputTokens: null, outputTokens: null, totalTokens: null, source: "unknown", scope: "turn" }, cost: unknownCost("turn"), reason: sanitizeLabel(reason, 500), warnings: [warning("reviewer_hard_limit", reason, observed, limit)] };
  await appendJsonl(telemetryPath(workspace), record);
}

function estimatedTokens(events: ArcEvent[]): TokenMeasurement {
  return tokenMeasurement(events.filter((event) => event.type === "user_prompt").map((event) => event.text ?? "").join("\n"), events.filter((event) => event.type === "assistant_message").map((event) => event.text ?? "").join("\n"), "session");
}
function tokenMeasurement(input: string, output: string, scope: "turn" | "session"): TokenMeasurement { const inputTokens = tokenEstimate(input); const outputTokens = tokenEstimate(output); return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens, source: "estimate", scope }; }
function tokenEstimate(value: string): number { return Math.ceil([...value].length / 4); }
function unknownCost(scope: "turn" | "session"): CostMeasurement { return { amount: null, currency: "USD", source: "unknown", scope }; }
function runOutcome(events: ArcEvent[], failedTools: number): [RunTelemetryRecord["status"], string] { const text = events.slice().reverse().find((event) => event.type === "session_end")?.text?.toLowerCase() ?? ""; if (text.includes("cancel") || text.includes("abort")) return ["cancelled", "session cancelled"]; if (text.includes("fail") || text.includes("error")) return ["failed", "session ended with failure signal"]; if (events.some((event) => event.type === "session_end") && failedTools === 0) return ["success", "session completed"]; if (failedTools) return ["failed", "tool failure observed"]; return ["unknown", "no terminal outcome signal"]; }
function toolFingerprint(event: ArcEvent, sessionId: string): string { return hash(`${sessionId}\0${redactSensitiveText(`${event.toolName ?? "tool"}\0${event.command ?? ""}`).replace(/\s+/g, " ").slice(0, 1000)}`).slice(0, 24); }
function toolStatus(event: ArcEvent): ToolCallTelemetry["status"] { if (event.toolStatus === "success" || event.toolStatus === "failed") return event.toolStatus; if (typeof event.exitCode === "number") return event.exitCode === 0 ? "success" : "failed"; return "unknown"; }
function durationBetween(start: string, end: string): number | null { const left = Date.parse(start); const right = Date.parse(end); return Number.isFinite(left) && Number.isFinite(right) ? Math.max(0, right - left) : null; }
function sanitizeLabel(value: string, max: number): string { return redactSensitiveText(value).replace(/[\n\r\t]/g, " ").slice(0, max).trim(); }
function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function normalizedKey(value: string): string { return value.toLowerCase().replace(/[^a-z0-9]/g, ""); }
function weakMatchReason(value: string): boolean { return /weak|below|no matching|abstain|declined/i.test(value); }
function staleRejectionReason(value: string): boolean { return /stale/i.test(value) && /reject/i.test(value); }
function warning(code: PolicyWarning["code"], message: string, observed: number, limit: number): PolicyWarning { return { code, message: sanitizeLabel(message, 500), observed, limit }; }
function ratio(value: number, total: number): number { return total ? value / total : 0; }
function roundMoney(value: number): number { return Math.round(value * 1_000_000) / 1_000_000; }
function mixedSource(values: MeasurementSource[]): MeasurementSource | "mixed" { const sources = [...new Set(values.filter((value) => value !== "unknown"))]; return sources.length > 1 ? "mixed" : sources[0] ?? "unknown"; }
function percentiles(values: (number | null)[]): Percentiles { const sorted = values.filter((value): value is number => value !== null && Number.isFinite(value)).sort((a, b) => a - b); const at = (q: number) => sorted.length ? sorted[Math.max(0, Math.ceil(sorted.length * q) - 1)] : null; return { count: sorted.length, p50: at(0.5), p95: at(0.95), p99: at(0.99) }; }
function telemetryRecordIsRedacted(record: TelemetryRecord): boolean { const text = JSON.stringify(record); return redactSensitiveText(text) === text && !["\"command\":", "\"path\":", "\"prompt\":", "\"output\":", "\"raw\":"].some((needle) => text.includes(needle)); }
function configuredNumber(value: unknown, envName: string, fallback: number | null): number | null { const envValue = process.env[envName]; const selected = envValue === undefined ? value : envValue; if (selected === null || selected === "null" || selected === "none" || selected === "off") return null; const number = typeof selected === "number" ? selected : typeof selected === "string" && selected.trim() ? Number(selected) : NaN; return Number.isFinite(number) && number >= 0 ? number : fallback; }
function isRecord(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function isTelemetryRecord(value: unknown): value is TelemetryRecord { return isRecord(value) && value.schemaVersion === 1 && (value.kind === "run" || value.kind === "reviewer_call") && typeof value.sessionId === "string" && Array.isArray(value.warnings); }
