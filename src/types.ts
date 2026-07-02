export type Runner = "copilot" | "opencode" | "claude" | "codex";

export type CapsuleStatus = "local" | "shareable" | "shared" | "rejected" | "superseded" | "private";

export type PrivacyLabel = "local" | "shareable" | "private" | "redacted";

export type ArcEventType =
  | "session_start"
  | "user_prompt"
  | "assistant_message"
  | "tool_start"
  | "tool_end"
  | "awaiting_input"
  | "session_end"
  | "unknown";

export interface ArcEvent {
  id: string;
  runner: Runner;
  sessionId: string;
  workspace: string;
  timestamp: string;
  type: ArcEventType;
  source: string;
  text?: string;
  toolName?: string;
  toolUseId?: string;
  command?: string;
  path?: string;
  toolStatus?: "success" | "failed" | "unknown";
  exitCode?: number;
  rawType?: string;
  raw?: unknown;
}

export type EvidenceOutcomeStatus = "success" | "partial" | "failed" | "aborted" | "unknown";

export interface EvidenceOutcome {
  status: EvidenceOutcomeStatus;
  confidence: number;
  reasons: string[];
  successSignals: string[];
  failureSignals: string[];
  abortedSignals: string[];
}

export interface EvidencePacket {
  runner: Runner;
  sessionId: string;
  workspace: string;
  createdAt: string;
  episodes: EvidenceEpisode[];
  prompts: string[];
  assistantMessages: string[];
  toolEvents: ArcEvent[];
  commands: string[];
  paths: string[];
  eventCount: number;
  outcome: EvidenceOutcome;
}

export interface AssembledDraft {
  packetKind: "assembled_draft";
  runner: Runner;
  sessionId: string;
  workspace: string;
  createdAt: string;
  goalId: string;
  mergeKey: string;
  span: {
    startEventId?: string;
    endEventId?: string;
    eventCount: number;
  };
  goal: string;
  prompts: string[];
  evidenceSnippets?: string[];
  commands: string[];
  parameters: string[];
  paths: string[];
  outcome: EvidenceOutcome;
  observations: ObserverJudgment[];
  sourceEventIds: string[];
}

export type ReviewPacket = EvidencePacket | AssembledDraft;

export interface EvidenceEpisode {
  prompt: string;
  assistantMessages: string[];
  commands: string[];
  paths: string[];
  toolEvents: ArcEvent[];
  outcome: EvidenceOutcome;
}

export interface WorkflowCapsule {
  purpose: string;
  parameters: string[];
  bindingSources: string[];
  steps: string[];
  commands: string[];
  successCriteria: string[];
  failedAttempts: string[];
  validationProbe: string[];
}

export interface CapsuleEmbedding {
  model: string;
  textHash: string;
  vector: number[];
  createdAt: string;
}

export interface CapsuleGraphEdge {
  to: string;
  kind: "similar" | "duplicate" | "supersedes";
  score?: number;
  reason: string;
  createdAt: string;
}

export interface BindingSourceSnapshot {
  source: string;
  exists: boolean;
  hash?: string;
  capturedAt: string;
}

export interface CapsuleStaleness {
  stale: boolean;
  checkedAt: string;
  reasons: string[];
}

export interface Capsule {
  id: string;
  runner: Runner;
  workspace: string;
  workspaceKey: string;
  workspaceGroup: string;
  sourceSessionId: string;
  sourceSessionIds: string[];
  createdAt: string;
  updatedAt: string;
  status: CapsuleStatus;
  privacyLabel: PrivacyLabel;
  contributors: string[];
  useCount: number;
  successCount: number;
  failureCount: number;
  kind: string;
  mergeKey: string;
  title: string;
  summary: string;
  reusable: boolean;
  confidence: number;
  reuseWhen: string[];
  doNotReuseWhen: string[];
  evidence: string[];
  provenance: string[];
  artifactSources: string[];
  supersedes: string[];
  supersededBy: string[];
  confidenceReason: string;
  failureBoundary: string[];
  validationProvenance: string[];
  outcomeStatus: EvidenceOutcomeStatus;
  nextRunInstruction: string;
  workflow: WorkflowCapsule;
  embedding?: CapsuleEmbedding;
  graph?: CapsuleGraphEdge[];
  bindingSnapshots?: BindingSourceSnapshot[];
  staleness?: CapsuleStaleness;
}

export interface InjectionPlan {
  shouldInject: boolean;
  capsule?: Capsule;
  message: string;
  reason: string;
  source?: "sidecar" | "local";
  judgeDecisionId?: string;
  consultApplied?: boolean;
  consultCapsuleId?: string;
  consultAbstainReason?: string;
  actionRisk?: string;
}

export interface SidecarReview {
  shouldSave: boolean;
  capsule?: Partial<Capsule> & {
    workflow?: Partial<WorkflowCapsule>;
  };
  capsules?: (Partial<Capsule> & {
    workflow?: Partial<WorkflowCapsule>;
  })[];
  reason?: string;
}

export interface SidecarConsult {
  applies: boolean;
  capsuleId?: string;
  confidence?: number;
  reason?: string;
  note?: string;
}

export interface ObserverPacket {
  runner: Runner;
  sessionId: string;
  workspace: string;
  createdAt: string;
  elapsedMs: number;
  eventCount: number;
  newEventCount: number;
  prompts: string[];
  assistantMessages: string[];
  commands: string[];
  paths: string[];
  recentEvents: ArcEvent[];
}

export interface ObserverJudgment {
  status?: string;
  currentGoal?: string;
  importantSignals?: string[];
  possibleReusableWork?: boolean;
  suggestedCapsule?: {
    title?: string;
    why?: string;
    reusableShape?: string;
    likelyBindingSources?: string[];
    usefulCommands?: string[];
  };
  risks?: string[];
  watchNext?: string[];
  reason?: string;
}

export type LocalObserverTask = "observe" | "consult" | "review";

export interface LocalObserverInput {
  task: LocalObserverTask;
  workspace: string;
  prompt?: string;
  packet?: ReviewPacket | ObserverPacket;
  capsules?: Capsule[];
}

export interface LocalObserverDecision {
  route?: "call-strong-model" | "handled-locally";
  consultChoice?: string;
  reviewVerdict?: "reusable-method" | "not-worth-saving";
  shouldCallStrongModel?: boolean;
  shouldShowMemoryUi?: boolean;
  providerClass?: "copilot" | "codex" | "openai" | "anthropic" | "local-large" | "configured";
  confidence?: number;
  reason?: string;
  consult?: SidecarConsult;
  review?: SidecarReview;
  observation?: ObserverJudgment;
}

export type LocalObserverSource = "builtin" | "command" | "builtin-fallback";

export interface LocalObserverResult {
  decision: LocalObserverDecision;
  source: LocalObserverSource;
  fallbackError?: string;
}

export interface LocalObserverStatus {
  enabled: boolean;
  mode: "off" | "builtin" | "command";
  model: string;
  detail: string;
}

export type ReviewIntent = "auto" | "user-requested";

export interface ReviewRecurrence {
  mergeKey: string;
  recurrenceCount: number;
  priorDeclineReason: string;
  priorSessionIds: string[];
}

export interface SidecarReviewRequest {
  runner: Runner;
  intent: ReviewIntent;
  packet: ReviewPacket;
  prompt: string;
  existingCapsules?: Capsule[];
  reviewContext?: Pick<SidecarReviewOptions, "consultApplied" | "consultCapsuleId" | "consultAbstainReason" | "actionRisk" | "injectedCapsuleIds" | "judgeDecisionIds" | "recurrence">;
}

export interface SidecarReviewOptions {
  reviewer?: (request: SidecarReviewRequest) => Promise<SidecarReview | null>;
  injectedCapsuleIds?: string[];
  judgeDecisionIds?: string[];
  consultApplied?: boolean;
  consultCapsuleId?: string;
  consultAbstainReason?: string;
  actionRisk?: string;
  recurrence?: ReviewRecurrence;
}
