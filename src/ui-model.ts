import type { CopilotHookStatus } from "./hook-status.js";
import type { CopilotSdkExtensionStatus } from "./copilot-extension.js";
import type { ArcIntegration } from "./install.js";
import type { CapsuleStatus, PrivacyLabel } from "./types.js";

export interface ArcUiStatus {
  repo: string;
  workspace: string;
  cacheDir: string;
  capsuleCount: number;
  eventCount: number;
  judge: ArcUiJudgeStatus;
  integration: ArcIntegration | null;
  extension: CopilotSdkExtensionStatus;
  hook: CopilotHookStatus;
  lastInjection: ArcUiEventRow | null;
  lastSave: ArcUiEventRow | null;
  generatedAt: string;
}

export interface ArcUiJudgeStatus {
  mode: "embedding-only" | "provider-judge";
  model: {
    provider: "copilot" | "ollama";
    id: string;
  } | null;
}

export interface ArcUiCapsuleRow {
  id: string;
  shortId: string;
  title: string;
  summary: string;
  status: CapsuleStatus;
  privacyLabel: PrivacyLabel;
  kind: string;
  confidence: number;
  updatedAt: string;
  useCount: number;
  reuseWhen: string[];
  doNotReuseWhen: string[];
  nextRunInstruction: string;
  steps: string[];
  commands: string[];
  validationProbe: string[];
  failedAttempts: string[];
}

export interface ArcUiEventRow {
  id: string;
  type: string;
  timestamp: string;
  capsuleId?: string;
  sessionId?: string;
  title: string;
  detail: string;
}

export interface ArcUiViewModel {
  status: ArcUiStatus;
  query: string;
  capsules: ArcUiCapsuleRow[];
  selectedCapsule: ArcUiCapsuleRow | null;
  recentEvents: ArcUiEventRow[];
}

export interface ArcUiState {
  mode: "list" | "detail";
  query: string;
  selectedId?: string;
  selectedIndex: number;
  listOffset: number;
  feedOffset: number;
  searchActive: boolean;
  message?: string;
}

export type ArcUiAction =
  | { type: "set-status"; capsuleId: string; status: CapsuleStatus }
  | { type: "set-privacy"; capsuleId: string; privacyLabel: PrivacyLabel }
  | { type: "enable"; capsuleId: string }
  | { type: "disable"; capsuleId: string }
  | { type: "invalidate"; capsuleId: string }
  | { type: "set-judge-mode"; mode: "embedding-only" | "provider-judge" }
  | { type: "set-judge-model"; model: { provider: "copilot" | "ollama"; id: string } };
