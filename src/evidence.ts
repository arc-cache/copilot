import type { ArcEvent, EvidenceEpisode, EvidenceOutcome, EvidenceOutcomeStatus, EvidencePacket } from "./types.js";

export function buildEvidencePacket(events: ArcEvent[], workspace: string, sessionId: string): EvidencePacket {
  const prompts = unique(events.filter((event) => event.type === "user_prompt").map((event) => event.text ?? ""));
  const assistantMessages = unique(events.filter((event) => event.type === "assistant_message").map((event) => event.text ?? ""));
  const toolEvents = events.filter((event) => event.type === "tool_start" || event.type === "tool_end");
  const commands = unique(toolEvents.map((event) => event.command ?? "").filter(Boolean));
  const paths = unique(events.flatMap((event) => pathsFromEvent(event)));
  const outcome = classifyOutcome(events);
  return {
    runner: events.find((event) => event.runner)?.runner ?? "copilot",
    sessionId,
    workspace,
    createdAt: new Date().toISOString(),
    episodes: buildEpisodes(events),
    prompts,
    assistantMessages: assistantMessages.slice(-20),
    toolEvents: toolEvents.slice(-80),
    commands: commands.slice(-40),
    paths: paths.slice(0, 80),
    eventCount: events.length,
    outcome
  };
}

function buildEpisodes(events: ArcEvent[]): EvidenceEpisode[] {
  const episodes: EvidenceEpisode[] = [];
  let current: EvidenceEpisode | null = null;
  for (const event of events) {
    if (event.type === "user_prompt") {
      if (current && current.assistantMessages.length === 0 && current.commands.length === 0 && current.toolEvents.length === 0) {
        current.prompt = event.text ?? current.prompt;
        continue;
      }
      if (current) episodes.push(trimEpisode(current));
      current = { prompt: event.text ?? "", assistantMessages: [], commands: [], paths: [], toolEvents: [], outcome: unknownOutcome() };
      continue;
    }
    if (!current) continue;
    if (event.type === "assistant_message" && event.text) current.assistantMessages.push(event.text);
    if (event.type === "tool_start" || event.type === "tool_end") {
      current.toolEvents.push(event);
      if (event.command) current.commands.push(event.command);
    }
    current.paths.push(...pathsFromEvent(event));
  }
  if (current) episodes.push(trimEpisode(current));
  return episodes.slice(-20);
}

function trimEpisode(episode: EvidenceEpisode): EvidenceEpisode {
  const episodeEvents: ArcEvent[] = [
    ...episode.assistantMessages.map((text, index) => syntheticTextEvent(text, index)),
    ...episode.toolEvents
  ];
  return {
    prompt: episode.prompt,
    assistantMessages: unique(episode.assistantMessages).slice(-8),
    commands: unique(episode.commands).slice(-12),
    paths: unique(episode.paths).slice(0, 24),
    toolEvents: episode.toolEvents.slice(-20),
    outcome: classifyOutcome(episodeEvents)
  };
}

function syntheticTextEvent(text: string, index: number): ArcEvent {
  return {
    id: `episode-text-${index}`,
    runner: "copilot",
    sessionId: "episode",
    workspace: "",
    timestamp: new Date(0).toISOString(),
    type: "assistant_message",
    source: "episode",
    text
  };
}

function pathsFromEvent(event: ArcEvent): string[] {
  const values: string[] = [];
  visitStrings(event.raw, (value) => {
    if (looksLikePath(value)) values.push(value.trim());
  });
  return values;
}

function visitStrings(value: unknown, fn: (value: string) => void): void {
  if (typeof value === "string") {
    fn(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) visitStrings(item, fn);
    return;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value as Record<string, unknown>)) visitStrings(item, fn);
  }
}

function looksLikePath(value: string): boolean {
  const text = value.trim();
  if (!text.includes("/") || text.length > 260) return false;
  if (text.includes("\n") || text.includes("\r") || text.includes("\t")) return false;
  if (text.split(" ").length > 1) return false;
  return text.split("/").filter(Boolean).length >= 2;
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function classifyOutcome(events: ArcEvent[]): EvidenceOutcome {
  const assistantTail = events
    .filter((event) => event.type === "assistant_message" && event.text)
    .slice(-5)
    .map((event) => event.text ?? "");
  const finalAssistant = assistantTail.at(-1)?.toLowerCase() ?? "";
  const toolTail = events
    .filter((event) => event.type === "tool_end")
    .slice(-20);
  const text = [...assistantTail, ...toolTail.map((event) => `${event.command ?? ""}\n${event.text ?? ""}`)].join("\n").toLowerCase();
  const successSignals = collectSignals(text, [
    "done",
    "succeeded",
    "successfully",
    "passed",
    "verified",
    "working",
    "deployed",
    "stopped",
    "fixed",
    "completed",
    "health ok",
    "exit code: 0",
    "exit code 0"
  ]);
  const failureSignals = collectSignals(text, [
    "failed",
    "failure",
    "not reachable",
    "network is unreachable",
    "permission denied",
    "timed out",
    "timeout",
    "connection refused",
    "no route to host",
    "exit code: 1",
    "exit code 1",
    "exit code: 255",
    "exit code 255",
    "command not found",
    "syntax error",
    "could not",
    "couldn't",
    "cannot"
  ]);
  const abortedSignals = collectSignals(text, [
    "stopped by user",
    "user stopped",
    "aborted",
    "cancelled",
    "canceled",
    "interrupted",
    "stop_bash"
  ]);
  for (const event of toolTail) {
    if (event.toolStatus === "failed" || (typeof event.exitCode === "number" && event.exitCode !== 0)) {
      failureSignals.push(event.exitCode === undefined ? "tool reported failure" : `tool exit code ${event.exitCode}`);
    }
    if (event.toolName === "stop_bash") abortedSignals.push("stop_bash tool used");
  }
  const status = outcomeStatus(successSignals, failureSignals, abortedSignals, finalAssistant);
  const reasons = [
    successSignals.length ? `success signals: ${unique(successSignals).slice(0, 4).join(", ")}` : "",
    failureSignals.length ? `failure signals: ${unique(failureSignals).slice(0, 4).join(", ")}` : "",
    abortedSignals.length ? `aborted signals: ${unique(abortedSignals).slice(0, 4).join(", ")}` : ""
  ].filter(Boolean);
  return {
    status,
    confidence: status === "unknown" ? 0.25 : status === "partial" ? 0.55 : 0.7,
    reasons,
    successSignals: unique(successSignals).slice(0, 12),
    failureSignals: unique(failureSignals).slice(0, 12),
    abortedSignals: unique(abortedSignals).slice(0, 12)
  };
}

function outcomeStatus(successSignals: string[], failureSignals: string[], abortedSignals: string[], finalAssistant: string): EvidenceOutcomeStatus {
  if (abortedSignals.length && !successSignals.length) return "aborted";
  if (successSignals.length && failureSignals.length && finalAssistantClaimsSuccess(finalAssistant)) return "success";
  if (successSignals.length && failureSignals.length) return "partial";
  if (successSignals.length) return "success";
  if (failureSignals.length) return "failed";
  if (abortedSignals.length) return "partial";
  return "unknown";
}

function finalAssistantClaimsSuccess(text: string): boolean {
  if (!text) return false;
  const strongSuccess = /\b(succeeded|successfully|verified|completed|works|working|fixed|passed)\b/.test(text);
  if (!strongSuccess) return false;
  const unresolvedFailure = /\b(failed|failure|not reachable|network is unreachable|permission denied|timed out|timeout|connection refused|no route to host|exit code:?\s*(1|255)|command not found|syntax error|could not|couldn't|cannot)\b/.test(text);
  return !unresolvedFailure || /\b(non[- ]blocking|eventually|after retry|recovered|still completed|completed successfully|probe still completed)\b/.test(text);
}

function unknownOutcome(): EvidenceOutcome {
  return {
    status: "unknown",
    confidence: 0.25,
    reasons: [],
    successSignals: [],
    failureSignals: [],
    abortedSignals: []
  };
}

function collectSignals(text: string, needles: string[]): string[] {
  const signals: string[] = [];
  for (const needle of needles) {
    if (text.includes(needle)) signals.push(needle);
  }
  return signals;
}
