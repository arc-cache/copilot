import { appendJsonl, readJsonl } from "./json.js";
import { memoryEventsPath, workspaceRoot } from "./paths.js";

export type MemoryEventType =
  | "turn.started"
  | "capsule.injected"
  | "runner.started"
  | "runner.completed"
  | "runner.failed"
  | "capsule.created"
  | "capsule.updated"
  | "capsule.merged"
  | "capsule.related"
  | "capsule.superseded"
  | "capsule.rejected"
  | "capsule.privacy_updated"
  | "capsule.checkpointed"
  | "capsule.finalized";

export interface MemoryEvent {
  id: string;
  type: MemoryEventType;
  timestamp: string;
  workspace: string;
  sessionId?: string;
  turnId?: string;
  capsuleId?: string;
  details?: Record<string, unknown>;
}

export async function recordMemoryEvent(input: Omit<MemoryEvent, "id" | "timestamp" | "workspace"> & {
  workspace?: string;
}): Promise<MemoryEvent> {
  const event: MemoryEvent = {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
    type: input.type,
    timestamp: new Date().toISOString(),
    workspace: input.workspace ?? workspaceRoot(),
    sessionId: input.sessionId,
    turnId: input.turnId,
    capsuleId: input.capsuleId,
    details: input.details
  };
  await appendJsonl(memoryEventsPath(event.workspace), event);
  return event;
}

export async function loadMemoryEvents(workspace = workspaceRoot()): Promise<MemoryEvent[]> {
  return (await readJsonl<unknown>(memoryEventsPath(workspace))).filter(isMemoryEvent);
}

function isMemoryEvent(value: unknown): value is MemoryEvent {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.type === "string" && typeof record.timestamp === "string" && typeof record.workspace === "string";
}
