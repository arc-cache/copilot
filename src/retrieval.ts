import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import { loadArcConfig } from "./config.js";
import { LOCAL_EMBEDDING_MODEL_NAME, embedTexts } from "./local-embeddings.js";
import { loadRetrievalReputation, recordJudgeDecision } from "./retrieval-reputation.js";
import { debug, incrementCapsuleUse, loadCapsules, updateCapsuleDerivedData } from "./store.js";
import { consultCapsuleVault } from "./sidecar.js";
import type { BindingSourceSnapshot, Capsule, CapsuleEmbedding, CapsuleGraphEdge, InjectionPlan, Runner } from "./types.js";

export interface InjectionContext {
  /** Earlier prompts from the same session, oldest first. */
  recentPrompts?: string[];
  /** Session handling this prompt, used to reconcile Gate-1 outcomes later. */
  sessionId?: string;
  /** Runner handling this prompt, used to avoid cross-runner strong sidecars. */
  runner?: Runner;
}

export interface CapsuleSearchResult {
  id: string;
  title: string;
  summary: string;
  score: number;
  adjustedScore: number;
  reputation: number;
  source: "embedding" | "lexical";
  reuseWhen: string[];
  nextRunInstruction: string;
}

export async function searchCapsulesForQuery(
  query: string,
  workspace: string,
  options: { limit?: number } = {}
): Promise<CapsuleSearchResult[]> {
  const capsules = (await loadCapsules(workspace))
    .filter(isRetrievableCapsule)
    .filter((capsule) => !matchesDoNotReuse(normalize(query), capsule));
  if (!capsules.length) return [];
  const reputation = await loadRetrievalReputation(workspace);
  const promptVector = (await embedTexts([query], workspace))?.[0];
  const lexicalPrompt = normalize(query);
  const scored = capsules.map((capsule): CapsuleSearchResult => {
    const semanticScore = promptVector?.length && capsule.embedding?.vector.length
      ? cosine(promptVector, capsule.embedding.vector)
      : -1;
    const lexicalScore = scoreCapsule(lexicalPrompt, capsule);
    const source = semanticScore >= embeddingThreshold() ? "embedding" : "lexical";
    const score = source === "embedding" ? semanticScore : lexicalScore;
    const multiplier = reputation.get(capsule.id) ?? 1;
    return {
      id: capsule.id,
      title: capsule.title,
      summary: capsule.summary,
      score,
      adjustedScore: score * multiplier,
      reputation: multiplier,
      source,
      reuseWhen: capsule.reuseWhen,
      nextRunInstruction: capsule.nextRunInstruction
    };
  }).filter((item) => item.score > 0)
    .sort((left, right) => right.adjustedScore - left.adjustedScore || right.score - left.score);
  return scored.slice(0, Math.max(1, Math.min(options.limit ?? 5, 20)));
}

export async function buildInjectionPlan(prompt: string, workspace: string, context: InjectionContext = {}): Promise<InjectionPlan> {
  if (nonTaskPrompt(prompt)) return { shouldInject: false, message: "", reason: "small-talk prompt", source: "local" };
  const capsules = await loadCapsules(workspace);
  const normalizedPrompt = normalize(prompt);
  if (matchesAnyDoNotReuse(normalizedPrompt, capsules)) {
    return { shouldInject: false, message: "", reason: "prompt matched a do-not-reuse guard", source: "local" };
  }
  const actionRisk = actionRiskGate(prompt);
  const candidateCapsules = actionRisk ? capsules.filter((capsule) => !liveActionCapsule(capsule)) : capsules;
  if (actionRisk && candidateCapsules.length !== capsules.length) {
    await debug("retrieval.action_risk_filtered", {
      reason: actionRisk,
      filteredCount: capsules.length - candidateCapsules.length
    }, workspace);
  }
  if (!candidateCapsules.length) {
    return { shouldInject: false, message: "", reason: actionRisk ?? "no matching capsule", source: "local", actionRisk: actionRisk || undefined };
  }
  // Follow-up prompts ("did not help", "same change again", "what command?")
  // have no anchors of their own; match against the recent session prompts
  // too, so the conversation topic keeps retrieving the same capsules.
  const recentPrompts = (context.recentPrompts ?? []).filter(Boolean).slice(-3);
  const matchText = followUpPrompt(prompt) && recentPrompts.length
    ? [...recentPrompts, prompt].join("\n")
    : prompt;
  const ranked = await rankCapsules(matchText, candidateCapsules, workspace);
  const shortlist = ranked.available
    ? ranked.shortlist
    : shortlistCapsules(matchText, candidateCapsules);
  if (ranked.available && !shortlist.length) {
    return { shouldInject: false, message: "", reason: ranked.reason, source: "local", actionRisk: actionRisk || undefined };
  }
  const config = await loadArcConfig();
  const judgeMode = config.injectionJudgeMode ?? "embedding-only";
  const explicitConsult = !!process.env.AGENT_RUN_CACHE_CONSULT_COMMAND;
  const providerJudgeConfigured = judgeMode === "provider-judge" && !!config.injectionJudgeModel;
  const shouldJudge = explicitConsult || (providerJudgeConfigured && shouldUseProviderJudge(judgeMode, ranked));
  let sidecar: Awaited<ReturnType<typeof consultCapsuleVault>> = null;
  let sidecarFailure: string | undefined;
  let judgeDecisionId: string | undefined;
  if (shouldJudge) {
    try {
      sidecar = await consultCapsuleVault(matchText, shortlist, workspace, {
        runner: context.runner,
        judgeModel: judgeMode === "provider-judge" ? config.injectionJudgeModel : undefined
      });
      if (judgeMode === "provider-judge") {
        const accepted = Boolean(sidecar?.applies && sidecar.capsuleId && (explicitConsult || judgeConfidence(sidecar) >= providerJudgeConfidenceThreshold()));
        const decision = await recordJudgeDecision({
          workspace,
          sessionId: context.sessionId,
          prompt: matchText,
          mode: "provider-judge",
          model: config.injectionJudgeModel,
          candidates: rankedCandidates(ranked, shortlist),
          verdict: accepted && sidecar?.capsuleId
            ? { inject: sidecar.capsuleId, confidence: sidecar.confidence ?? 0.5, reason: sidecar.reason }
            : { abstain: true, confidence: sidecar?.confidence ?? 0.5, reason: sidecar?.reason ?? "judge abstained" },
          outcome: { injected: accepted, used: "unknown", helped: "unknown" }
        });
        judgeDecisionId = decision.id;
      }
    } catch (error) {
      sidecarFailure = summarizeSidecarFailure(error);
      await debug("retrieval.sidecar_failed", { error: String(error), reason: sidecarFailure }, workspace);
    }
  } else if (providerJudgeConfigured && ranked.available) {
    const decision = await recordJudgeDecision({
      workspace,
      sessionId: context.sessionId,
      prompt: matchText,
      mode: "provider-judge",
      model: config.injectionJudgeModel,
      candidates: rankedCandidates(ranked, shortlist),
      verdict: providerJudgeHighConfidence(ranked)
        ? { inject: ranked.best?.id, confidence: ranked.topScore, reason: "embedding score above high band; judge skipped" }
        : { abstain: true, confidence: ranked.topScore, reason: ranked.available ? "embedding score below judge band" : ranked.reason },
      outcome: { injected: Boolean(providerJudgeHighConfidence(ranked) && ranked.best), used: "unknown", helped: "unknown" }
    });
    judgeDecisionId = decision.id;
  }
  const mode = orientingPrompt(prompt) ? "orient" : "act";
  const sidecarAccepted = Boolean(sidecar?.applies && sidecar.capsuleId && (explicitConsult || judgeConfidence(sidecar) >= providerJudgeConfidenceThreshold()));
  if (sidecarAccepted && sidecar?.capsuleId) {
    const capsule = shortlist.find((item) => item.id === sidecar.capsuleId) ?? candidateCapsules.find((item) => item.id === sidecar.capsuleId);
    if (capsule && !matchesDoNotReuse(normalize(prompt), capsule)) {
      const current = await flagCapsuleStaleness(capsule, workspace);
      const used = await incrementCapsuleUse(current.id, workspace);
      return {
        shouldInject: true,
        capsule: used ?? current,
        reason: sidecar.reason ?? `sidecar selected capsule ${current.id}`,
        message: formatSidecarConsultNote(used ?? current, sidecar.note, mode, prompt),
        source: "sidecar",
        judgeDecisionId,
        consultApplied: true,
        consultCapsuleId: current.id,
        actionRisk: actionRisk || undefined
      };
    }
  }
  if (sidecar && (!sidecar.applies || !sidecarAccepted)) {
    return {
      shouldInject: false,
      message: "",
      reason: !sidecar.applies
        ? sidecar.reason ?? "consult sidecar declined capsule reuse"
        : `consult sidecar confidence below ${providerJudgeConfidenceThreshold().toFixed(2)}`,
      source: "sidecar",
      judgeDecisionId,
      consultApplied: false,
      consultAbstainReason: !sidecar.applies
        ? sidecar.reason ?? "consult sidecar declined capsule reuse"
        : `consult sidecar confidence below ${providerJudgeConfidenceThreshold().toFixed(2)}`,
      actionRisk: actionRisk || undefined
    };
  }
  const capsule = ranked.available ? ranked.best : selectCapsule(matchText, candidateCapsules);
  if (!capsule) {
    return {
      shouldInject: false,
      message: "",
      reason: sidecar?.reason ?? sidecarFailure ?? "no matching capsule",
      source: "local",
      judgeDecisionId,
      actionRisk: actionRisk || undefined
    };
  }
  const current = await flagCapsuleStaleness(capsule, workspace);
  const used = await incrementCapsuleUse(current.id, workspace);
  return {
    shouldInject: true,
    capsule: used ?? current,
    reason: ranked.available ? ranked.reason : `matched capsule ${current.id}`,
    message: formatCapsuleNote(used ?? current, mode, prompt),
    source: "local",
    judgeDecisionId,
    actionRisk: actionRisk || undefined
  };
}

export async function refreshCapsuleDerivedData(capsule: Capsule, workspace: string): Promise<Capsule> {
  const embedding = await embeddingForCapsule(capsule, workspace);
  const bindingSnapshots = await captureBindingSnapshots(capsule, workspace);
  if (!embedding && !bindingSnapshots.length) return capsule;
  const existing = await loadCapsules(workspace);
  const graph = embedding ? graphForCapsule(capsule.id, embedding, existing) : capsule.graph;
  const updated = await updateCapsuleDerivedData(capsule.id, {
    embedding: embedding ?? capsule.embedding,
    graph,
    bindingSnapshots: bindingSnapshots.length ? bindingSnapshots : capsule.bindingSnapshots
  }, workspace);
  return updated ?? capsule;
}

// A prompt that leans on the conversation rather than naming its subject:
// anaphora ("this", "it"), continuation phrases, or just very few tokens.
function followUpPrompt(prompt: string): boolean {
  const normalized = normalize(prompt);
  const tokens = normalized.split(" ").filter(Boolean);
  if (tokens.length <= 10) return true;
  return /\b(did not help|didnt help|doesn.?t work|same (change|thing|issue|error)|try again|still (fails|failing|broken)|what (command|does|is) (it|this|that)|why (is|does) (it|this|that)|fix (it|this|that)|instead)\b/.test(normalized);
}

function nonTaskPrompt(prompt: string): boolean {
  const normalized = normalize(prompt).replace(/[^a-z0-9]+/g, " ").trim();
  if (!normalized) return true;
  const smallTalk = new Set(["hi", "hello", "hey", "yo", "sup", "thanks", "thank you", "ok", "okay", "cool", "nice", "lol", "haha"]);
  return smallTalk.has(normalized);
}

function actionRiskGate(prompt: string): string {
  const normalized = normalize(prompt);
  if (explicitNoLiveAction(normalized)) return "prompt explicitly disallows live or remote actions";
  if (manualAdvicePrompt(normalized) && !explicitLiveActionIntent(normalized)) return "prompt asks for manual guidance rather than live action";
  if (pastedDiagnosticPrompt(prompt, normalized) && !explicitLiveActionIntent(normalized)) {
    return "prompt is pasted diagnostic output without live-action intent";
  }
  if (adviceOnlyPrompt(normalized) && !explicitLiveActionIntent(normalized)) {
    return "prompt asks for advice without live-action intent";
  }
  return "";
}

function liveActionCapsule(capsule: Capsule): boolean {
  const text = [
    ...(capsule.workflow?.commands ?? []),
    ...(capsule.workflow?.validationProbe ?? []),
    ...(capsule.workflow?.failedAttempts ?? [])
  ].join("\n").toLowerCase();
  return /\b(?:ssh|scp|rsync|kubectl|external-runner)\b/.test(text) ||
    /\bdocker\s+exec\b/.test(text);
}

function explicitNoLiveAction(prompt: string): boolean {
  if (/\b(?:no|without)\s+external-runner\b/.test(prompt)) return true;
  return /\b(?:no|without)\s+(?:running|runs?|execution|executing|live|remote|external|connection)\b/.test(prompt) ||
    /\b(?:do not|dont|don't|never)\s+(?:run|execute|touch|change|mutate|connect|inspect live|use remote)\b/.test(prompt) ||
    /\bjust\s+(?:tell|explain|describe)\b.*\b(?:no|without)\s+(?:running|executing|live|remote|external)\b/.test(prompt);
}

function manualAdvicePrompt(prompt: string): boolean {
  return /\bmanual(?:ly)?\b/.test(prompt) && /\b(?:how|check|verify|tell|show|steps?)\b/.test(prompt);
}

function pastedDiagnosticPrompt(rawPrompt: string, prompt: string): boolean {
  if (/\b(?:pasted|output|logs?|trace|transcript|stderr|stdout|diagnostic|dump)\b/.test(prompt)) return true;
  const diagnosticLines = rawPrompt.split(/\r?\n/).filter((line) =>
    /^\s*(?:\$|>|#)\s+\S/.test(line) ||
    /\b(?:error|failed|failure|warning|traceback|exception|stderr|stdout|missing|invalid|timeout)\b/i.test(line)
  );
  return rawPrompt.split(/\r?\n/).length >= 4 && diagnosticLines.length >= 2;
}

function adviceOnlyPrompt(prompt: string): boolean {
  return /\b(?:just|only)\s+(?:tell|explain|describe|say)\b/.test(prompt) ||
    /\bhow\s+(?:do|can|should)\s+i\b/.test(prompt) ||
    /\bwhat\s+(?:should|would|can)\s+i\b/.test(prompt);
}

function explicitLiveActionIntent(prompt: string): boolean {
  return /\bexternal-runner\b/.test(prompt) ||
    /\b(?:connect\s+to|log\s+into|login\s+to)\b/.test(prompt) ||
    /\b(?:run|execute|inspect|check|probe|debug|connect)\b.{0,60}\b(?:live|remote|external|server|host|resource|environment)\b/.test(prompt) ||
    /\b(?:live|remote|external|server|host|resource|environment)\b.{0,60}\b(?:run|execute|inspect|check|probe|debug|connect)\b/.test(prompt);
}

function shortlistCapsules(prompt: string, capsules: Capsule[], limit = 8): Capsule[] {
  const reusable = capsules.filter(isRetrievableCapsule);
  const normalizedPrompt = normalize(prompt);
  const scored = reusable
    .filter((capsule) => !matchesDoNotReuse(normalizedPrompt, capsule))
    .map((capsule) => ({ capsule, score: scoreCapsule(normalizedPrompt, capsule), recency: Date.parse(capsule.updatedAt) || 0 }))
    .sort((left, right) => right.score - left.score || right.recency - left.recency || right.capsule.confidence - left.capsule.confidence);
  const matches = scored.filter((item) => item.score > 0).slice(0, limit).map((item) => item.capsule);
  if (matches.length) return matches;
  return scored.sort((left, right) => right.recency - left.recency || right.capsule.confidence - left.capsule.confidence).slice(0, Math.min(4, limit)).map((item) => item.capsule);
}

interface RankedCapsules {
  available: boolean;
  shortlist: Capsule[];
  best: Capsule | null;
  scores: RankedCapsuleScore[];
  topScore?: number;
  reason: string;
}

interface RankedCapsuleScore {
  capsule: Capsule;
  score: number;
  adjustedScore: number;
  reputation: number;
}

async function rankCapsules(prompt: string, capsules: Capsule[], workspace: string): Promise<RankedCapsules> {
  const reusable = capsules
    .filter(isRetrievableCapsule)
    .filter((capsule) => !matchesDoNotReuse(normalize(prompt), capsule));
  if (!reusable.length) return { available: false, shortlist: [], best: null, scores: [], reason: "no retrievable capsules" };
  const promptVectors = await embedTexts([prompt], workspace);
  const promptVector = promptVectors?.[0];
  if (!promptVector?.length) return { available: false, shortlist: [], best: null, scores: [], reason: "embeddings unavailable" };

  const embedded = await ensureEmbeddingsForCapsules(reusable, workspace);
  const reputation = await loadRetrievalReputation(workspace);
  const scored = embedded
    .map((capsule): RankedCapsuleScore => {
      const score = capsule.embedding ? cosine(promptVector, capsule.embedding.vector) : -1;
      const multiplier = reputation.get(capsule.id) ?? 1;
      return {
        capsule,
        score,
        adjustedScore: score * multiplier,
        reputation: multiplier
      };
    })
    .filter((item) => item.score >= embeddingThreshold())
    .sort((left, right) => right.adjustedScore - left.adjustedScore || right.score - left.score || right.capsule.confidence - left.capsule.confidence);
  const shortlist = scored.slice(0, embeddingShortlistLimit()).map((item) => item.capsule);
  const best = shortlist[0] ?? null;
  const topScore = scored[0]?.score;
  return {
    available: true,
    shortlist,
    best,
    scores: scored,
    topScore,
    reason: topScore === undefined
      ? `embedding distance gate abstained below ${embeddingThreshold().toFixed(2)}`
      : `embedding matched capsule ${best?.id ?? "unknown"} at ${topScore.toFixed(3)}`
  };
}

async function ensureEmbeddingsForCapsules(capsules: Capsule[], workspace: string): Promise<Capsule[]> {
  const fresh: Capsule[] = [];
  const stale = capsules.filter((capsule) => {
    const hash = capsuleTextHash(capsule);
    if (capsule.embedding?.model === LOCAL_EMBEDDING_MODEL_NAME && capsule.embedding.textHash === hash && capsule.embedding.vector.length) {
      fresh.push(capsule);
      return false;
    }
    return true;
  });
  if (!stale.length) return fresh;
  const vectors = await embedTexts(stale.map(capsuleEmbeddingText), workspace);
  if (!vectors) return capsules;
  const now = new Date().toISOString();
  const withEmbeddings = stale.map((capsule, index) => ({
    ...capsule,
    embedding: {
      model: LOCAL_EMBEDDING_MODEL_NAME,
      textHash: capsuleTextHash(capsule),
      vector: vectors[index],
      createdAt: now
    }
  }));
  const all = [...fresh, ...withEmbeddings];
  await Promise.all(withEmbeddings.map(async (capsule) => {
    const graph = capsule.embedding ? graphForCapsule(capsule.id, capsule.embedding, all) : capsule.graph;
    const bindingSnapshots = await captureBindingSnapshots(capsule, workspace);
    await updateCapsuleDerivedData(capsule.id, {
      embedding: capsule.embedding,
      graph,
      bindingSnapshots: bindingSnapshots.length ? bindingSnapshots : capsule.bindingSnapshots
    }, workspace);
  }));
  return all;
}

async function embeddingForCapsule(capsule: Capsule, workspace: string): Promise<CapsuleEmbedding | undefined> {
  const hash = capsuleTextHash(capsule);
  if (capsule.embedding?.model === LOCAL_EMBEDDING_MODEL_NAME && capsule.embedding.textHash === hash && capsule.embedding.vector.length) {
    return capsule.embedding;
  }
  const vectors = await embedTexts([capsuleEmbeddingText(capsule)], workspace);
  const vector = vectors?.[0];
  if (!vector?.length) return undefined;
  return {
    model: LOCAL_EMBEDDING_MODEL_NAME,
    textHash: hash,
    vector,
    createdAt: new Date().toISOString()
  };
}

function graphForCapsule(id: string, embedding: CapsuleEmbedding, capsules: Capsule[]): CapsuleGraphEdge[] {
  const now = new Date().toISOString();
  return capsules
    .filter((capsule) => capsule.id !== id && capsule.embedding?.vector.length)
    .map((capsule) => ({
      to: capsule.id,
      kind: "similar" as const,
      score: cosine(embedding.vector, capsule.embedding?.vector ?? []),
      reason: "capsule embedding similarity",
      createdAt: now
    }))
    .filter((edge) => edge.score >= graphSimilarityThreshold())
    .sort((left, right) => (right.score ?? 0) - (left.score ?? 0))
    .slice(0, 12);
}

async function flagCapsuleStaleness(capsule: Capsule, workspace: string): Promise<Capsule> {
  if (!capsule.bindingSnapshots?.length) return capsule;
  const current = await captureBindingSnapshots(capsule, workspace);
  if (!current.length) return capsule;
  const bySource = new Map(current.map((snapshot) => [snapshot.source, snapshot]));
  const reasons: string[] = [];
  for (const previous of capsule.bindingSnapshots) {
    const next = bySource.get(previous.source);
    if (!next) continue;
    if (previous.exists !== next.exists) reasons.push(`${previous.source} existence changed`);
    else if (previous.hash && next.hash && previous.hash !== next.hash) reasons.push(`${previous.source} content hash changed`);
  }
  const staleness = {
    stale: reasons.length > 0,
    checkedAt: new Date().toISOString(),
    reasons: reasons.slice(0, 12)
  };
  if (capsule.staleness?.stale === staleness.stale && JSON.stringify(capsule.staleness.reasons) === JSON.stringify(staleness.reasons)) {
    return capsule;
  }
  const updated = await updateCapsuleDerivedData(capsule.id, { staleness }, workspace);
  return updated ?? { ...capsule, staleness };
}

async function captureBindingSnapshots(capsule: Capsule, workspace: string): Promise<BindingSourceSnapshot[]> {
  const values = activeBindingSources(capsule)
    .filter((source) => source && !source.includes("<") && !/^https?:\/\//i.test(source))
    .slice(0, 12);
  const snapshots: BindingSourceSnapshot[] = [];
  for (const source of values) {
    const path = isAbsolute(source) ? source : resolve(workspace, source);
    if (!path.startsWith(resolve(workspace)) && !isAbsolute(source)) continue;
    const capturedAt = new Date().toISOString();
    if (!existsSync(path)) {
      snapshots.push({ source, exists: false, capturedAt });
      continue;
    }
    try {
      const info = await stat(path);
      if (!info.isFile() || info.size > maxSnapshotBytes()) {
        snapshots.push({ source, exists: true, hash: sha256(`${info.size}:${Math.floor(info.mtimeMs)}`), capturedAt });
        continue;
      }
      const data = await readFile(path);
      snapshots.push({ source, exists: true, hash: sha256(data), capturedAt });
    } catch {
      snapshots.push({ source, exists: false, capturedAt });
    }
  }
  return snapshots;
}

function capsuleEmbeddingText(capsule: Capsule): string {
  return [
    capsule.title,
    capsule.summary,
    capsule.nextRunInstruction,
    ...capsule.reuseWhen,
    ...capsule.doNotReuseWhen,
    capsule.workflow?.purpose ?? "",
    ...(capsule.workflow?.parameters ?? []),
    ...activeBindingSources(capsule),
    ...(capsule.workflow?.steps ?? [])
  ].filter(Boolean).join("\n").slice(0, 6000);
}

function capsuleTextHash(capsule: Capsule): string {
  return sha256(capsuleEmbeddingText(capsule));
}

function cosine(left: number[], right: number[]): number {
  if (!left.length || left.length !== right.length) return -1;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftNorm += left[index] * left[index];
    rightNorm += right[index] * right[index];
  }
  if (!leftNorm || !rightNorm) return -1;
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function embeddingThreshold(): number {
  const value = Number(process.env.AGENT_RUN_CACHE_EMBEDDING_MATCH_THRESHOLD ?? 0.58);
  return Number.isFinite(value) ? Math.min(1, Math.max(-1, value)) : 0.58;
}

function providerJudgeHighThreshold(): number {
  const value = Number(process.env.AGENT_RUN_CACHE_JUDGE_HIGH_THRESHOLD ?? 0.74);
  return Number.isFinite(value) ? Math.min(1, Math.max(embeddingThreshold(), value)) : 0.74;
}

function providerJudgeConfidenceThreshold(): number {
  const value = Number(process.env.AGENT_RUN_CACHE_JUDGE_CONFIDENCE_THRESHOLD ?? 0.65);
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0.65;
}

function shouldUseProviderJudge(mode: string, ranked: RankedCapsules): boolean {
  return mode === "provider-judge"
    && ranked.available
    && ranked.topScore !== undefined
    && ranked.topScore >= embeddingThreshold()
    && ranked.topScore < providerJudgeHighThreshold();
}

function providerJudgeHighConfidence(ranked: RankedCapsules): boolean {
  return ranked.available
    && ranked.topScore !== undefined
    && ranked.topScore >= providerJudgeHighThreshold();
}

function rankedCandidates(ranked: RankedCapsules, fallback: Capsule[]): { capsuleId: string; score: number; reputation?: number }[] {
  if (ranked.scores.length) {
    return ranked.scores.slice(0, embeddingShortlistLimit()).map((item) => ({
      capsuleId: item.capsule.id,
      score: item.score,
      reputation: item.reputation
    }));
  }
  return fallback.map((capsule) => ({ capsuleId: capsule.id, score: 0 }));
}

function judgeConfidence(sidecar: { confidence?: number } | null): number {
  return typeof sidecar?.confidence === "number" && Number.isFinite(sidecar.confidence)
    ? Math.min(1, Math.max(0, sidecar.confidence))
    : 0.5;
}

function graphSimilarityThreshold(): number {
  const value = Number(process.env.AGENT_RUN_CACHE_GRAPH_SIMILARITY_THRESHOLD ?? 0.86);
  return Number.isFinite(value) ? Math.min(1, Math.max(-1, value)) : 0.86;
}

function embeddingShortlistLimit(): number {
  const value = Number(process.env.AGENT_RUN_CACHE_EMBEDDING_SHORTLIST ?? 8);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 8;
}

function maxSnapshotBytes(): number {
  const value = Number(process.env.AGENT_RUN_CACHE_BINDING_SNAPSHOT_MAX_BYTES ?? 256 * 1024);
  return Number.isFinite(value) && value > 0 ? value : 256 * 1024;
}

function selectCapsule(prompt: string, capsules: Capsule[]): Capsule | null {
  const normalizedPrompt = normalize(prompt);
  const candidates = capsules
    .filter(isRetrievableCapsule)
    .filter((capsule) => !matchesDoNotReuse(normalizedPrompt, capsule))
    .map((capsule) => ({ capsule, score: scoreCapsule(normalizedPrompt, capsule) }))
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => right.score - left.score || right.capsule.confidence - left.capsule.confidence);
  return candidates[0]?.capsule ?? null;
}

function isRetrievableCapsule(capsule: Capsule): boolean {
  if (!capsule.reusable || capsule.confidence < 0.5 || !capsule.workflow) return false;
  if (capsule.status === "private" || capsule.status === "rejected" || capsule.status === "superseded") return false;
  if (capsule.supersededBy?.length) return false;
  if (capsule.outcomeStatus === "aborted") return false;
  if (capsule.outcomeStatus === "failed") {
    const kind = capsule.kind.toLowerCase();
    return kind.includes("fact") || kind.includes("caution") || kind.includes("dead_end");
  }
  return true;
}

function scoreCapsule(prompt: string, capsule: Capsule): number {
  const promptTokens = new Set(prompt.split(" ").filter(Boolean));
  const phrases = [
    ...capsule.reuseWhen,
    capsule.title,
    capsule.workflow?.purpose ?? "",
    ...(capsule.workflow?.parameters ?? []),
    ...activeBindingSources(capsule)
  ].map(normalize).filter((phrase) => phrase.length >= 2);
  let score = 0;
  for (const phrase of phrases) {
    if (exactPhraseMatch(prompt, promptTokens, phrase)) score += 4;
    else {
      const important = phrase.split(" ").filter((part) => part.length >= 3);
      const hits = important.filter((part) => promptTokens.has(part)).length;
      if (important.length >= 2 && hits / important.length >= 0.5) score += 1;
    }
  }
  return score * capsule.confidence;
}

function exactPhraseMatch(prompt: string, promptTokens: Set<string>, phrase: string): boolean {
  const parts = phrase.split(" ").filter(Boolean);
  if (parts.length === 1 && parts[0].length < 3) return promptTokens.has(parts[0]);
  return prompt.includes(phrase);
}

function matchesDoNotReuse(prompt: string, capsule: Capsule): boolean {
  for (const phrase of capsule.doNotReuseWhen.map(normalize).filter((item) => item.length >= 3)) {
    if (prompt.includes(phrase)) return true;
    if (phrase.includes(prompt) && prompt.length >= 6) return true;
    const promptTokens = new Set(prompt.split(" ").filter(Boolean));
    const important = phrase.split(" ").filter((part) => part.length >= 3);
    const hits = important.filter((part) => promptTokens.has(part)).length;
    if (important.length && hits / important.length >= 0.75) return true;
  }
  return false;
}

function matchesAnyDoNotReuse(prompt: string, capsules: Capsule[]): boolean {
  return capsules.some((capsule) => isRetrievableCapsule(capsule) && matchesDoNotReuse(prompt, capsule));
}

type InjectionMode = "act" | "orient";

export function formatCapsuleNote(capsule: Capsule, mode: InjectionMode = "act", prompt = ""): string {
  if (mode === "act" && capsule.workflow?.commands?.length) {
    return formatActionCommandCapsuleNote(capsule, prompt);
  }
  const commandPolicy = mode === "orient"
    ? "Command policy: this looks like an explanation or orientation prompt. Read or inspect the binding sources first; do not run saved commands unless the user asks for execution or inspection leaves uncertainty."
    : capsule.workflow?.commands?.length
    ? "Command policy: reuse the captured command shape with fresh parameters after verifying current binding sources."
    : "Command policy: no reusable command shape was captured; do not invent one from memory. Verify the binding sources and answer or ask before running optional probes.";
  const minimalPolicy = minimalVerificationPolicy(capsule, mode);
  const remotePolicy = remoteCommandPolicy(capsule);
  const stale = stalePolicy(capsule);
  const lines = [
    "Agent Run Cache sidecar note:",
    mode === "orient"
      ? "A prior session saved project context that may answer this orientation prompt. Verify the binding sources before broad rediscovery."
      : actionCapsuleIntro(capsule),
    "",
    `Capsule: ${capsule.title}`,
    capsule.summary ? `Summary: ${capsule.summary}` : "",
    capsule.nextRunInstruction ? `First move: ${capsule.nextRunInstruction}` : "",
    commandPolicy,
    minimalPolicy,
    remotePolicy,
    stale,
    list("Reuse when", capsule.reuseWhen),
    list("Do not reuse when", capsule.doNotReuseWhen),
    list("Binding sources to verify", activeBindingSources(capsule)),
    list("Reusable artifacts", capsule.artifactSources ?? []),
    list("Validation probe", capsule.workflow?.validationProbe ?? []),
    list("Reusable steps", capsule.workflow?.steps ?? []),
    list(mode === "orient" ? "Command shapes captured for action tasks" : "Command shapes", capsule.workflow?.commands ?? []),
    list("Dead ends to avoid", capsule.workflow?.failedAttempts ?? []),
    "",
    "Use this as a shortcut, not as truth. Do not require provenance-only files unless the capsule lists them as binding sources."
  ];
  return lines.filter(Boolean).join("\n").slice(0, 5000);
}

function formatSidecarConsultNote(capsule: Capsule, note: string | undefined, mode: InjectionMode, prompt = ""): string {
  if (mode === "act" && capsule.workflow?.commands?.length) {
    return formatActionCommandConsultNote(capsule, note, prompt);
  }
  const commandPolicy = mode === "orient"
    ? "Command policy: this looks like an explanation or orientation prompt. Read or inspect the binding sources first; do not run saved commands unless the user asks for execution or inspection leaves uncertainty."
    : capsule.workflow?.commands?.length
    ? "Reusable command shape exists in the capsule; use it with fresh parameters after verifying the binding sources."
    : "No reusable command shape is captured in this capsule; do not invent a new command from the memory. Use the saved workflow first, then answer or ask if live execution is still needed.";
  const minimalPolicy = minimalVerificationPolicy(capsule, mode);
  const remotePolicy = remoteCommandPolicy(capsule);
  const stale = stalePolicy(capsule);
  const lines = [
    "Agent Run Cache consult:",
    mode === "orient"
      ? "The sidecar found close prior project context. Treat it as an orientation shortcut, not a command to execute."
      : `The sidecar found ${actionCapsuleLabel(capsule)}. Treat this as the first path to try, not background trivia.`,
    mode === "orient"
      ? "Before broad exploration, inspect the named binding sources and answer from current evidence. Do not require provenance-only files."
      : "Before broad exploration, verify the named binding sources and follow the capsule's first move. Do not require provenance-only files.",
    commandPolicy,
    minimalPolicy,
    remotePolicy,
    stale,
    "",
    `Matched capsule: ${capsule.title}`,
    capsule.nextRunInstruction ? `First move: ${capsule.nextRunInstruction}` : "",
    list("Binding sources to verify", activeBindingSources(capsule)),
    list("Reusable artifacts", capsule.artifactSources ?? []),
    note?.trim() ? `${mode === "orient" ? "Sidecar context" : "Sidecar instruction"}: ${note.trim()}` : "",
    "",
    "After using this, continue normally only if current evidence contradicts it or the user asks for more."
  ];
  return lines.filter(Boolean).join("\n").slice(0, 5000);
}

function formatActionCommandCapsuleNote(capsule: Capsule, prompt: string): string {
  const lines = [
    "Agent Run Cache action note:",
    `${actionCapsuleIntro(capsule)} Try this route before rediscovery.`,
    `Capsule: ${capsule.title}`,
    capsule.nextRunInstruction ? `First move: ${capsule.nextRunInstruction}` : "",
    concreteTargetPolicy(prompt),
    "Minimal verification policy: verify only the named binding sources with targeted searches, existence checks, or narrow selectors, then run the captured command shape. Use the user's concrete target terms; avoid generic broad patterns across whole files. One narrow pass per binding source is enough before the first attempt when it finds the target. Do not read provenance-only artifacts, reusable artifacts, command scripts, or whole files before the first attempt unless a targeted check is missing or stale, the command looks destructive, the command fails, or the user asks for deeper investigation.",
    remoteCommandPolicy(capsule),
    stalePolicy(capsule),
    list("Binding sources to verify", activeBindingSources(capsule)),
    list("Validation probe", capsule.workflow?.validationProbe ?? []),
    list("Command shapes", capsule.workflow?.commands ?? []),
    list("Dead ends to avoid", capsule.workflow?.failedAttempts ?? []),
    "",
    "After this route succeeds, answer from the result. Broaden only if current evidence contradicts the capsule or the user asks for more."
  ];
  return lines.filter(Boolean).join("\n").slice(0, 3500);
}

function formatActionCommandConsultNote(capsule: Capsule, note: string | undefined, prompt: string): string {
  const lines = [
    "Agent Run Cache action note:",
    `The sidecar found ${actionCapsuleLabel(capsule)}. Try this route before rediscovery.`,
    `Capsule: ${capsule.title}`,
    capsule.nextRunInstruction ? `First move: ${capsule.nextRunInstruction}` : "",
    concreteTargetPolicy(prompt),
    "Minimal verification policy: verify only the named binding sources with targeted searches, existence checks, or narrow selectors, then run the captured command shape. Use the user's concrete target terms; avoid generic broad patterns across whole files. One narrow pass per binding source is enough before the first attempt when it finds the target. Do not read provenance-only artifacts, reusable artifacts, command scripts, or whole files before the first attempt unless a targeted check is missing or stale, the command looks destructive, the command fails, or the user asks for deeper investigation.",
    remoteCommandPolicy(capsule),
    stalePolicy(capsule),
    list("Binding sources to verify", activeBindingSources(capsule)),
    list("Validation probe", capsule.workflow?.validationProbe ?? []),
    list("Command shapes", capsule.workflow?.commands ?? []),
    list("Dead ends to avoid", capsule.workflow?.failedAttempts ?? []),
    note?.trim() ? `Sidecar instruction: ${note.trim()}` : "",
    "",
    "After this route succeeds, answer from the result. Broaden only if current evidence contradicts the capsule or the user asks for more."
  ];
  return lines.filter(Boolean).join("\n").slice(0, 3500);
}

function actionCapsuleIntro(capsule: Capsule): string {
  const label = actionCapsuleLabel(capsule);
  if (capsule.kind.toLowerCase() === "command") {
    return `A prior session saved ${label} that may apply. Reuse the captured command shape after verifying current files, tools, and environment.`;
  }
  if (capsule.kind.toLowerCase().includes("fact")) {
    return `A prior session saved ${label} that may apply. Verify the binding sources before broad rediscovery.`;
  }
  return `A prior session saved ${label} that may apply. Follow the capsule's first move before broad rediscovery, then verify current files, tools, and environment.`;
}

function actionCapsuleLabel(capsule: Capsule): string {
  const kind = capsule.kind.toLowerCase();
  if (kind === "command") return "a reusable command capsule";
  if (kind.includes("fact")) return "reusable project context";
  if (kind === "runbook") return "a reusable runbook capsule";
  return "a reusable workflow capsule";
}

function minimalVerificationPolicy(capsule: Capsule, mode: InjectionMode): string {
  if (mode === "orient" || !capsule.workflow?.commands?.length) return "";
  return "Minimal verification policy: before the first command attempt, verify only the named binding sources with targeted searches, existence checks, or narrow selectors. Use the validation probe when it is specific. Do not read provenance-only artifacts, reusable artifacts, command scripts, or whole files for background context unless a targeted check is missing or stale, the command looks destructive, the command fails, or the user asks for deeper investigation.";
}

function concreteTargetPolicy(prompt: string): string {
  const terms = concretePromptTerms(prompt);
  if (!terms.length) return "";
  return `Concrete target terms for the first narrow search: ${terms.join(", ")}. If these match the binding sources, do not run broader generic searches before the first command attempt.`;
}

function concretePromptTerms(prompt: string): string[] {
  const stop = new Set(["test", "ssh", "run", "check", "verify", "fix", "debug", "to", "the", "a", "an", "with", "for", "from"]);
  const values = prompt
    .toLowerCase()
    .match(/[a-z0-9][a-z0-9_.:-]*[a-z0-9]/g) ?? [];
  return uniqueStrings(values
    .map((value) => value.replace(/^[._:-]+|[._:-]+$/g, ""))
    .filter((value) => value.length >= 2)
    .filter((value) => !stop.has(value))
    .filter((value) => /[0-9_.:-]/.test(value))
  ).slice(0, 4);
}

function list(title: string, values: string[]): string {
  if (!values.length) return "";
  return `${title}:\n${values.slice(0, 6).map((value) => `- ${value}`).join("\n")}`;
}

function remoteCommandPolicy(capsule: Capsule): string {
  const text = [
    ...(capsule.workflow?.commands ?? []),
    ...(capsule.workflow?.steps ?? []),
    capsule.nextRunInstruction
  ].join("\n").toLowerCase();
  if (!/\bssh\b|\bscp\b|\brsync\b|\bdocker\b/.test(text)) return "";
  return "Remote command policy: use bounded, noninteractive probes where possible, for example BatchMode and ConnectTimeout for SSH. Treat password prompts, hung sessions, and transient health failures as outcome evidence rather than successful workflow proof.";
}

function stalePolicy(capsule: Capsule): string {
  if (!capsule.staleness?.stale) return "";
  const reasons = capsule.staleness.reasons.slice(0, 4).join("; ");
  return `Staleness policy: one or more binding sources changed since this capsule was saved (${reasons}). Reverify current files before reuse; do not discard the capsule automatically.`;
}

function activeBindingSources(capsule: Capsule): string[] {
  const artifactSources = new Set((capsule.artifactSources ?? []).map(normalize));
  return (capsule.workflow?.bindingSources ?? []).filter((source) => {
    if (!artifactSources.has(normalize(source))) return true;
    return !/\.md$/i.test(source) && !/\b(runbook|notes?|instructions?)\b/i.test(source);
  });
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function normalize(value: string): string {
  const allowed = new Set("abcdefghijklmnopqrstuvwxyz0123456789_./@:-".split(""));
  const out: string[] = [];
  let spacing = false;
  for (const char of value.toLowerCase().trim()) {
    if (allowed.has(char)) {
      if (spacing && out.length) out.push(" ");
      spacing = false;
      out.push(char);
    } else {
      spacing = true;
    }
  }
  return out.join("");
}

function orientingPrompt(prompt: string): boolean {
  const words = new Set(normalize(prompt).split(" ").filter(Boolean));
  for (const word of ["what", "whats", "explain", "describe", "overview", "about", "where", "which", "list", "show"]) {
    if (words.has(word)) return true;
  }
  return false;
}

function summarizeSidecarFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/quota/i.test(message)) return "sidecar quota exceeded; using local matching only";
  return "sidecar unavailable; using local matching only";
}
