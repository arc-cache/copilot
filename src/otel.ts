import { readJsonl } from "./json.js";
import type { ArcEvent } from "./types.js";

interface OTelRecord {
  type?: string;
  traceId?: string;
  spanId?: string;
  parentSpanId?: string;
  name?: string;
  startTime?: unknown;
  endTime?: unknown;
  attributes?: Record<string, unknown>;
  status?: { code?: number; message?: string };
}

interface ChatMessage {
  role?: string;
  parts?: ChatPart[];
}

interface ChatPart {
  type?: string;
  content?: string;
  text?: string;
  name?: string;
  arguments?: unknown;
}

export async function readCopilotOtelEvents(path: string, workspace: string, fallbackSessionId = "unknown"): Promise<ArcEvent[]> {
  const records = await readJsonl<OTelRecord>(path);
  return normalizeOtelRecords(records, workspace, fallbackSessionId);
}

export function normalizeOtelRecords(records: OTelRecord[], workspace: string, fallbackSessionId = "unknown"): ArcEvent[] {
  const spans = records.filter((record) => record.type === "span");
  const sessionId = sessionIdFromSpans(spans) ?? fallbackSessionId;
  const events: ArcEvent[] = [];
  const seenUserMessages = new Set<string>();
  const seenAssistantMessages = new Set<string>();
  let sequence = 0;

  for (const span of spans) {
    const attributes = span.attributes ?? {};
    const operation = stringValue(attributes["gen_ai.operation.name"]);
    const name = stringValue(span.name);
    if (operation === "chat" || name.startsWith("chat ")) {
      for (const message of parseMessages(attributes["gen_ai.input.messages"])) {
        if (message.role !== "user") continue;
        const text = stripInjectedPrompt(messageText(message));
        if (!text) continue;
        const key = stableMessageKey(text);
        if (seenUserMessages.has(key)) continue;
        seenUserMessages.add(key);
        events.push({
          id: `${sessionId}-otel-${sequence++}`,
          runner: "copilot",
          sessionId,
          workspace,
          timestamp: timestampFrom(span.startTime, sequence),
          type: "user_prompt",
          source: "copilot-otel",
          text,
          rawType: name || "chat",
          raw: { role: "user", content: text }
        });
      }
      for (const message of parseMessages(attributes["gen_ai.output.messages"])) {
        if (message.role !== "assistant") continue;
        const text = messageText(message);
        if (!text) continue;
        const key = stableMessageKey(text);
        if (seenAssistantMessages.has(key)) continue;
        seenAssistantMessages.add(key);
        events.push({
          id: `${sessionId}-otel-${sequence++}`,
          runner: "copilot",
          sessionId,
          workspace,
          timestamp: timestampFrom(span.endTime ?? span.startTime, sequence),
          type: "assistant_message",
          source: "copilot-otel",
          text,
          rawType: name || "chat",
          raw: { role: "assistant", content: text, usage: otelUsageAttributes(attributes) }
        });
      }
      continue;
    }

    if (operation === "execute_tool" || name.startsWith("execute_tool ")) {
      const toolName = stringValue(attributes["gen_ai.tool.name"]) || name.replace(/^execute_tool\s+/, "");
      const toolUseId = stringValue(attributes["gen_ai.tool.call.id"]) || stringValue(span.spanId);
      const argumentText = stringValue(attributes["gen_ai.tool.call.arguments"]);
      const resultText = stringValue(attributes["gen_ai.tool.call.result"]);
      const command = commandFromTool(toolName, argumentText);
      const exitCode = exitCodeFromText(resultText);
      const toolStatus = exitCode !== null
        ? exitCode === 0 ? "success" : "failed"
        : span.status?.code && span.status.code !== 0 ? "failed" : "success";
      const raw = {
        toolName,
        arguments: parseJson(argumentText) ?? argumentText,
        result: resultText.slice(0, 12000),
        status: span.status
      };
      events.push({
        id: `${sessionId}-otel-${sequence++}`,
        runner: "copilot",
        sessionId,
        workspace,
        timestamp: timestampFrom(span.startTime, sequence),
        type: "tool_start",
        source: "copilot-otel",
        toolName,
        toolUseId,
        command,
        rawType: name || "execute_tool",
        raw: { toolName, arguments: raw.arguments }
      });
      events.push({
        id: `${sessionId}-otel-${sequence++}`,
        runner: "copilot",
        sessionId,
        workspace,
        timestamp: timestampFrom(span.endTime ?? span.startTime, sequence),
        type: "tool_end",
        source: "copilot-otel",
        toolName,
        toolUseId,
        command,
        text: resultText.slice(0, 12000),
        toolStatus,
        exitCode: exitCode ?? undefined,
        rawType: name || "execute_tool",
        raw
      });
    }
  }

  return events.sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp) || left.id.localeCompare(right.id));
}

function sessionIdFromSpans(spans: OTelRecord[]): string | null {
  for (const span of spans) {
    const id = stringValue(span.attributes?.["gen_ai.conversation.id"]);
    if (id) return id;
  }
  return null;
}

function otelUsageAttributes(attributes: Record<string, unknown>): Record<string, number> {
  const usage: Record<string, number> = {};
  for (const key of [
    "gen_ai.usage.input_tokens",
    "gen_ai.usage.output_tokens",
    "gen_ai.usage.total_tokens",
    "gen_ai.usage.cost_usd"
  ]) {
    if (typeof attributes[key] === "number") usage[key] = attributes[key];
  }
  return usage;
}

function parseMessages(value: unknown): ChatMessage[] {
  const parsed = typeof value === "string" ? parseJson(value) : value;
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((item): item is ChatMessage => !!item && typeof item === "object");
}

function messageText(message: ChatMessage): string {
  const parts = Array.isArray(message.parts) ? message.parts : [];
  return parts
    .filter((part) => part.type === "text" || part.content || part.text)
    .map((part) => stringValue(part.content) || stringValue(part.text))
    .filter(Boolean)
    .join("\n")
    .trim();
}

function commandFromTool(toolName: string, argumentText: string): string {
  const parsed = parseJson(argumentText);
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const record = parsed as Record<string, unknown>;
    const direct = stringValue(record.command) || stringValue(record.cmd) || stringValue(record.script);
    if (direct) return direct;
    const path = stringValue(record.path) || stringValue(record.file_path);
    if (path) return `${toolName} ${path}`;
    const compact = JSON.stringify(record);
    return compact.length > 500 ? `${toolName} ${compact.slice(0, 500)}...` : `${toolName} ${compact}`;
  }
  return toolName;
}

function exitCodeFromText(text: string): number | null {
  const match = text.match(/\bexit\s+code:?\s+(-?\d+)\b/i) ?? text.match(/\bexited\s+with\s+(-?\d+)\b/i);
  return match ? Number(match[1]) : null;
}

function timestampFrom(value: unknown, sequence: number): string {
  if (Array.isArray(value) && typeof value[0] === "number") {
    const seconds = value[0];
    const nanos = typeof value[1] === "number" ? value[1] : 0;
    return new Date(seconds * 1000 + Math.floor(nanos / 1_000_000) + sequence).toISOString();
  }
  if (typeof value === "string") {
    const ms = Date.parse(value);
    if (Number.isFinite(ms)) return new Date(ms + sequence).toISOString();
  }
  return new Date(Date.now() + sequence).toISOString();
}

function stableMessageKey(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function stripInjectedPrompt(value: string): string {
  const userTask = "\n\nUser task:\n";
  const userTaskIndex = value.lastIndexOf(userTask);
  const stripped = userTaskIndex >= 0 ? value.slice(userTaskIndex + userTask.length) : value;
  const reminder = "\n\n<system_reminder>";
  const reminderIndex = stripped.indexOf(reminder);
  return (reminderIndex >= 0 ? stripped.slice(0, reminderIndex) : stripped).trim();
}

function parseJson(value: string): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}
