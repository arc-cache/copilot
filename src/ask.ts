import { spawn } from "node:child_process";

import { buildInjectionPlan } from "./retrieval.js";
import { debug } from "./store.js";
import type { InjectionPlan } from "./types.js";

export async function runAsk(args: string[], workspace: string): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    printAskUsage();
    return 0;
  }

  const { runner, prompt } = parseAskArgs(args);
  if (!prompt) throw new Error(askUsage());
  if (runner !== "opencode") throw new Error(`Unsupported ask runner: ${runner}. Only opencode is wired for arc ask.`);

  const plan = await safeInjectionPlan(prompt, workspace, runner);
  const finalPrompt = plan.shouldInject ? `${plan.message}\n\nUser task:\n${prompt}` : prompt;
  printAskHeader(plan);

  await debug("ask.runner.started", {
    runner,
    injected: plan.shouldInject,
    capsuleId: plan.capsule?.id,
    reason: plan.reason
  }, workspace);

  const code = await runProcess(opencodeBin(), ["run", finalPrompt], workspace);
  await debug("ask.runner.completed", {
    runner,
    exitCode: code,
    injected: plan.shouldInject,
    capsuleId: plan.capsule?.id
  }, workspace);

  console.log("");
  console.log(`ARC: runner ${runner} exit ${code}`);
  console.log(`ARC: injected capsule ${plan.capsule?.id ?? "none"}`);
  return code;
}

function parseAskArgs(args: string[]): { runner: string; prompt: string } {
  let runner = process.env.AGENT_RUN_CACHE_ASK_RUNNER ?? "opencode";
  const promptParts: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--runner") {
      runner = args[index + 1] ?? "";
      index += 1;
      continue;
    }
    if (arg.startsWith("--runner=")) {
      runner = arg.slice("--runner=".length);
      continue;
    }
    promptParts.push(arg);
  }
  return { runner, prompt: promptParts.join(" ").trim() };
}

function printAskUsage(): void {
  console.log(askUsage());
}

function askUsage(): string {
  return `Usage: arc ask [--runner opencode] <prompt>

Runs a CLI-first ARC turn through opencode run. ARC retrieves matching capsule context first, then streams the runner answer in this terminal.`;
}

async function safeInjectionPlan(prompt: string, workspace: string, runner: "opencode"): Promise<InjectionPlan> {
  try {
    return await buildInjectionPlan(prompt, workspace, { runner });
  } catch (error) {
    await debug("ask.injection_failed", { error: String(error) }, workspace);
    return { shouldInject: false, message: "", reason: `injection unavailable: ${summarizeAskError(error)}`, source: "local" };
  }
}

function summarizeAskError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/quota/i.test(message)) return "sidecar quota exceeded";
  return "see ARC debug logs";
}

function printAskHeader(plan: InjectionPlan): void {
  if (plan.shouldInject) {
    console.log(`ARC: using capsule "${plan.capsule?.title ?? plan.capsule?.id ?? "unknown"}"`);
    console.log(`ARC: ${plan.reason}`);
  } else {
    console.log(`ARC: no capsule injected (${plan.reason})`);
  }
  console.log("");
}

function opencodeBin(): string {
  return process.env.AGENT_RUN_CACHE_OPENCODE_BIN ?? "opencode";
}

async function runProcess(command: string, args: string[], cwd: string): Promise<number> {
  const child = spawn(command, args, {
    cwd,
    stdio: "inherit",
    env: {
      ...process.env,
      OPENCODE_CLIENT: process.env.OPENCODE_CLIENT ?? "arc"
    }
  });
  return await new Promise<number>((resolve, reject) => {
    child.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        reject(new Error(`OpenCode runner not found: ${command}. Install OpenCode or set AGENT_RUN_CACHE_OPENCODE_BIN.`));
        return;
      }
      reject(error);
    });
    child.on("exit", (code) => resolve(code ?? 0));
  });
}
