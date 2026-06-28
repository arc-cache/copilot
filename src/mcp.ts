import { createInterface } from "node:readline";
import { readFile } from "node:fs/promises";

import { loadMemoryEvents } from "./ledger.js";
import { copilotPluginWorkspacePath, workspaceRoot } from "./paths.js";
import { searchCapsulesForQuery } from "./retrieval.js";
import { loadCapsules } from "./store.js";
import type { Capsule } from "./types.js";

type JsonRecord = Record<string, unknown>;
type JsonRpcId = string | number | null;

const SERVER_VERSION = "2.1.0";

export async function runMcpServer(): Promise<number> {
  const lines = createInterface({ input: process.stdin });
  for await (const line of lines) {
    const message = parseMessage(line);
    if (!message) continue;
    await handleMessage(message).catch((error) => {
      const id = requestId(message);
      if (id !== undefined) write(errorResponse(id, -32603, error instanceof Error ? error.message : String(error)));
    });
  }
  return 0;
}

async function handleMessage(message: JsonRecord): Promise<void> {
  const id = requestId(message);
  const method = typeof message.method === "string" ? message.method : "";
  if (id === undefined || !method) return;
  if (method === "initialize") {
    write(resultResponse(id, {
      protocolVersion: protocolVersion(message),
      capabilities: { tools: {} },
      serverInfo: { name: "arc", version: SERVER_VERSION }
    }));
    return;
  }
  if (method === "ping") {
    write(resultResponse(id, {}));
    return;
  }
  if (method === "tools/list") {
    write(resultResponse(id, { tools: tools() }));
    return;
  }
  if (method === "tools/call") {
    const params = isRecord(message.params) ? message.params : {};
    const name = typeof params.name === "string" ? params.name : "";
    const args = isRecord(params.arguments) ? params.arguments : {};
    write(resultResponse(id, await callTool(name, args)));
    return;
  }
  if (method === "shutdown") {
    write(resultResponse(id, null));
    return;
  }
  write(errorResponse(id, -32601, `Unknown method: ${method}`));
}

function tools(): JsonRecord[] {
  return [
    {
      name: "arc_search",
      description: "Search ARC capsules for reusable methods relevant to a prompt.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "The prompt or task to search capsules for." },
          limit: { type: "number", description: "Maximum number of capsules to return." }
        },
        required: ["query"],
        additionalProperties: false
      }
    },
    {
      name: "arc_status",
      description: "Return ARC workspace status, capsule count, and recent activity summary.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false }
    },
    {
      name: "arc_capsule",
      description: "Return a single ARC capsule by id or id prefix.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "Capsule id or id prefix." }
        },
        required: ["id"],
        additionalProperties: false
      }
    }
  ];
}

async function callTool(name: string, args: JsonRecord): Promise<JsonRecord> {
  const workspace = await resolveMcpWorkspace();
  if (name === "arc_status") {
    const [capsules, events] = await Promise.all([loadCapsules(workspace), loadMemoryEvents(workspace)]);
    return textResult(JSON.stringify({
      workspace,
      capsules: capsules.length,
      events: events.length,
      lastInjection: lastEvent(events, "capsule.injected"),
      lastSave: lastEvent(events, "capsule.finalized") ?? lastEvent(events, "capsule.created") ?? lastEvent(events, "capsule.updated")
    }, null, 2));
  }
  if (name === "arc_search") {
    const query = stringArg(args, "query");
    const limit = numberArg(args, "limit", 5);
    const results = await searchCapsulesForQuery(query, workspace, { limit });
    return textResult(JSON.stringify({ workspace, query, results }, null, 2));
  }
  if (name === "arc_capsule") {
    const id = stringArg(args, "id");
    const capsule = findCapsule(await loadCapsules(workspace), id);
    if (!capsule) return textResult(`No ARC capsule matches ${id}.`, true);
    return textResult(JSON.stringify({ workspace, capsule }, null, 2));
  }
  return textResult(`Unknown ARC MCP tool: ${name}.`, true);
}

async function resolveMcpWorkspace(): Promise<string> {
  const explicit = process.env.AGENT_RUN_CACHE_WORKSPACE?.trim();
  if (explicit) return workspaceRoot(explicit);
  const current = workspaceRoot();
  if (!isCopilotInstalledPluginPath(current)) return current;
  return await readRememberedCopilotWorkspace() ?? current;
}

async function readRememberedCopilotWorkspace(): Promise<string | null> {
  try {
    const data = JSON.parse(await readFile(copilotPluginWorkspacePath(), "utf8")) as { workspace?: unknown };
    return typeof data.workspace === "string" && data.workspace.trim() ? workspaceRoot(data.workspace) : null;
  } catch {
    return null;
  }
}

function isCopilotInstalledPluginPath(path: string): boolean {
  const normalized = path.replace(/\\/g, "/");
  return normalized.includes("/.copilot/installed-plugins/");
}

function textResult(text: string, isError = false): JsonRecord {
  return {
    content: [{ type: "text", text }],
    isError
  };
}

function findCapsule(capsules: Capsule[], id: string): Capsule | null {
  return capsules.find((capsule) => capsule.id === id || capsule.id.startsWith(id)) ?? null;
}

function lastEvent(events: Awaited<ReturnType<typeof loadMemoryEvents>>, type: string): JsonRecord | null {
  const event = events.slice().reverse().find((candidate) => candidate.type === type);
  return event ? {
    type: event.type,
    timestamp: event.timestamp,
    sessionId: event.sessionId,
    capsuleId: event.capsuleId,
    title: event.details?.title
  } : null;
}

function stringArg(args: JsonRecord, name: string): string {
  const value = args[name];
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a non-empty string`);
  return value.trim();
}

function numberArg(args: JsonRecord, name: string, fallback: number): number {
  const value = args[name];
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.min(20, Math.floor(number));
}

function parseMessage(line: string): JsonRecord | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const message = JSON.parse(trimmed);
    return isRecord(message) ? message : null;
  } catch {
    return null;
  }
}

function requestId(message: JsonRecord): JsonRpcId | undefined {
  const id = message.id;
  return typeof id === "string" || typeof id === "number" || id === null ? id : undefined;
}

function protocolVersion(message: JsonRecord): string {
  const params = isRecord(message.params) ? message.params : {};
  return typeof params.protocolVersion === "string" ? params.protocolVersion : "2024-11-05";
}

function resultResponse(id: JsonRpcId, result: unknown): JsonRecord {
  return { jsonrpc: "2.0", id, result };
}

function errorResponse(id: JsonRpcId, code: number, message: string): JsonRecord {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function write(message: JsonRecord): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
