import { existsSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";

import type { ArcConfig } from "./config.js";

export interface JudgeReachability {
  configured: boolean;
  reachable: boolean;
  path: string | null;
  check: "static";
  reason: string;
}

export function judgeReachability(config: ArcConfig): JudgeReachability {
  if ((config.injectionJudgeMode ?? "embedding-only") !== "provider-judge") {
    return {
      configured: false,
      reachable: false,
      path: null,
      check: "static",
      reason: "provider judge disabled"
    };
  }
  const model = config.injectionJudgeModel;
  if (!model) return unreachable("no judge model configured");

  const consultCommand = process.env.AGENT_RUN_CACHE_CONSULT_COMMAND?.trim();
  if (consultCommand === "off") return unreachable("AGENT_RUN_CACHE_CONSULT_COMMAND=off");
  if (consultCommand) {
    return {
      configured: true,
      reachable: true,
      path: "custom-consult-command",
      check: "static",
      reason: "custom consult command configured; live invocation not probed"
    };
  }

  const legacy = process.env.AGENT_RUN_CACHE_MODEL_SIDECAR?.trim();
  if (legacy && !["auto", "off", "opencode", "copilot"].includes(legacy)) {
    return {
      configured: true,
      reachable: true,
      path: "legacy-model-sidecar-command",
      check: "static",
      reason: "legacy model sidecar command configured; live invocation not probed"
    };
  }

  if (model.provider === "ollama") {
    return {
      configured: true,
      reachable: true,
      path: "built-in-ollama-api",
      check: "static",
      reason: "built-in Ollama judge path available; live model not probed"
    };
  }
  if (copilotJudgeCommandAvailable(config)) {
    return {
      configured: true,
      reachable: true,
      path: "built-in-copilot-sidecar",
      check: "static",
      reason: "built-in Copilot judge path available; live model not probed"
    };
  }
  return unreachable("Copilot sidecar command not found");
}

function unreachable(detail: string): JudgeReachability {
  return {
    configured: true,
    reachable: false,
    path: null,
    check: "static",
    reason: `judge configured but unreachable: ${detail}`
  };
}

function copilotJudgeCommandAvailable(config: ArcConfig): boolean {
  if ([
    process.env.AGENT_RUN_CACHE_SIDECAR_COPILOT_COMMAND,
    config.sidecarCopilotCommand,
    process.env.AGENT_RUN_CACHE_COPILOT_COMMAND
  ].some((value) => value?.trim())) {
    return true;
  }
  return executableAvailable(process.env.AGENT_RUN_CACHE_COPILOT_BIN ?? "copilot");
}

function executableAvailable(executable: string): boolean {
  if (isAbsolute(executable) || executable.includes("/") || executable.includes("\\")) {
    return existsSync(executable);
  }
  const suffixes = process.platform === "win32" ? ["", ".exe", ".cmd"] : [""];
  return (process.env.PATH ?? "")
    .split(delimiter)
    .filter(Boolean)
    .some((directory) => suffixes.some((suffix) => existsSync(join(directory, `${executable}${suffix}`))));
}
