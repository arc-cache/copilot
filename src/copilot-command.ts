import { loadArcConfigSync } from "./config.js";

export function copilotCommand(args: string[]): { command: string; args: string[]; label: string } {
  const fullCommand = process.env.AGENT_RUN_CACHE_COPILOT_COMMAND?.trim();
  if (fullCommand) return commandFromString(fullCommand, args, "AGENT_RUN_CACHE_COPILOT_COMMAND");

  const bin = process.env.AGENT_RUN_CACHE_COPILOT_BIN ?? "copilot";
  return { command: bin, args, label: bin };
}

export function copilotSidecarCommand(args: string[]): { command: string; args: string[]; label: string } {
  const sidecarCommand = process.env.AGENT_RUN_CACHE_SIDECAR_COPILOT_COMMAND?.trim();
  if (sidecarCommand) return commandFromString(sidecarCommand, args, "AGENT_RUN_CACHE_SIDECAR_COPILOT_COMMAND");
  const configured = loadArcConfigSync().sidecarCopilotCommand?.trim();
  if (configured) return commandFromString(configured, args, "ARC config sidecarCopilotCommand");
  return copilotCommand(args);
}

function commandFromString(fullCommand: string, args: string[], envName: string): { command: string; args: string[]; label: string } {
  const [command, ...baseArgs] = splitCommand(fullCommand);
  if (!command) throw new Error(`${envName} did not contain a command.`);
  return {
    command,
    args: [...baseArgs, ...integrationSeparator(command, baseArgs), ...args],
    label: fullCommand
  };
}

function integrationSeparator(command: string, args: string[]): string[] {
  if (command === "ollama" && args[0] === "launch" && !args.includes("--")) return ["--"];
  return [];
}

function splitCommand(command: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quote: "'" | "\"" | null = null;
  let escaped = false;

  for (const char of command) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === "'" || char === "\"") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        parts.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }

  if (escaped) current += "\\";
  if (quote) throw new Error("Copilot command has an unterminated quote.");
  if (current) parts.push(current);
  return parts;
}
