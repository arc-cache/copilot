// agent-run-cache/copilot-sdk-ui/v1
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { joinSession } from "@github/copilot-sdk/extension";

let session;

function extensionDir() {
  return dirname(fileURLToPath(import.meta.url));
}

function pathFileBin() {
  const pathFile = join(extensionDir(), "arc-bin.txt");
  if (!existsSync(pathFile)) return null;
  const value = readFileSync(pathFile, "utf8").trim();
  return value || null;
}

function findOnPath(name) {
  const path = process.env.PATH || "";
  for (const dir of path.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function arcCandidates() {
  const name = process.platform === "win32" ? "arc.exe" : "arc";
  return [
    process.env.ARC_BIN || null,
    findOnPath(name),
    findOnPath("arc"),
    pathFileBin(),
    name,
    "arc"
  ].filter((value, index, values) => value && values.indexOf(value) === index);
}

function workspacePath(context) {
  return session?.workspacePath || context?.workspacePath || process.env.AGENT_RUN_CACHE_WORKSPACE || process.cwd();
}

function runOneArc(bin, args, context, timeoutMs) {
  return new Promise((resolve) => {
    const cwd = workspacePath(context);
    const child = spawn(bin, args, {
      cwd,
      env: {
        ...process.env,
        AGENT_RUN_CACHE_WORKSPACE: cwd
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      resolve({ ok: false, retry: false, text: "ARC command timed out" });
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
      if (stdout.length > 2 * 1024 * 1024) stdout = stdout.slice(-2 * 1024 * 1024);
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
      if (stderr.length > 128 * 1024) stderr = stderr.slice(-128 * 1024);
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        ok: false,
        retry: error?.code === "ENOENT",
        text: error?.message || String(error)
      });
    });
    child.on("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        resolve({ ok: true, text: stdout.trim(), bin });
      } else {
        resolve({ ok: false, retry: false, text: (stderr || stdout || `arc exited ${code}`).trim(), bin });
      }
    });
  });
}

async function runArc(args, context, timeoutMs = 10000) {
  let last = { ok: false, text: "arc not found" };
  for (const bin of arcCandidates()) {
    last = await runOneArc(bin, args, context, timeoutMs);
    if (last.ok || !last.retry) return last;
  }
  return last;
}

async function runArcJson(args, context, timeoutMs = 10000) {
  const result = await runArc(args, context, timeoutMs);
  if (!result.ok) return { ok: false, text: result.text };
  try {
    return { ok: true, json: JSON.parse(result.text || "{}"), text: result.text };
  } catch (error) {
    return { ok: false, text: `ARC returned invalid JSON: ${error?.message || String(error)}` };
  }
}

async function safeLog(message, options) {
  try {
    await session?.log(String(message), options);
  } catch {}
}

function needsElicitation() {
  return session?.capabilities?.ui?.elicitation !== true;
}

async function runSafely(name, context, handler) {
  try {
    if (needsElicitation()) {
      await safeLog("ARC menu needs experimental mode: run /settings experimental on, then /clear");
      return;
    }
    await handler(context);
  } catch (error) {
    await safeLog(`ARC ${name} failed: ${error?.message || String(error)}`, { level: "warning" });
  }
}

async function topMenu(context) {
  await runSafely("menu", context, async () => {
    for (;;) {
      const selection = await session.ui.select("ARC", [
        "Browse capsules",
        "Pause / resume injection",
        "Switch judge model",
        "Status",
        "Cancel"
      ]);
      if (!selection || selection === "Cancel") return;
      if (selection === "Browse capsules") await browseCapsules(context);
      if (selection === "Pause / resume injection") await pauseMenu(context);
      if (selection === "Switch judge model") await judgeMenu(context);
      if (selection === "Status") await logStatus(context);
    }
  });
}

async function quickPause(context) {
  await runSafely("pause", context, pauseMenu);
}

async function quickJudge(context) {
  await runSafely("judge", context, judgeMenu);
}

async function logStatus(context) {
  const result = await runArc(["status"], context);
  await safeLog(result.text || "ARC status unavailable", { level: result.ok ? "info" : "warning" });
}

async function pauseMenu(context) {
  const selection = await session.ui.select("ARC injection", ["Pause 1h", "Pause today", "Resume"]);
  if (!selection) return;
  const args = selection === "Resume"
    ? ["resume"]
    : ["pause", selection === "Pause today" ? "today" : "1h"];
  const result = await runArc(args, context);
  await safeLog(result.text || "ARC pause command completed", { level: result.ok ? "info" : "warning" });
}

async function judgeMenu(context) {
  const result = await runArcJson(["judge", "models", "--json"], context, 12000);
  if (!result.ok) {
    await safeLog(result.text || "ARC could not list judge models", { level: "warning" });
    return;
  }
  const models = Array.isArray(result.json.models) ? result.json.models : [];
  if (!models.length) {
    await safeLog("No judge-capable models found.");
    return;
  }
  const labels = models.map((model) => {
    const id = `${model.provider}:${model.id}`;
    const hints = [model.name && model.name !== model.id ? model.name : null, model.sizeHint, model.costHint].filter(Boolean);
    return hints.length ? `${id} (${hints.join(", ")})` : id;
  });
  const selected = await session.ui.select("ARC judge model", labels);
  if (!selected) return;
  const index = labels.indexOf(selected);
  const model = models[index];
  if (!model) return;
  const set = await runArc(["judge", "set", `${model.provider}:${model.id}`], context);
  await safeLog(set.text || `judge model: ${model.provider}:${model.id}`, { level: set.ok ? "info" : "warning" });
}

async function browseCapsules(context) {
  for (;;) {
    const list = await runArcJson(["capsules", "--json"], context);
    if (!list.ok) {
      await safeLog(list.text || "ARC could not list capsules", { level: "warning" });
      return;
    }
    const capsules = Array.isArray(list.json.capsules) ? list.json.capsules : [];
    if (!capsules.length) {
      await safeLog("No ARC capsules saved yet.");
      return;
    }
    const labels = capsules.map((capsule) => `${capsule.title || capsule.id} (${String(capsule.id || "").slice(0, 8)})`);
    labels.push("Back");
    const selected = await session.ui.select("ARC capsules", labels);
    if (!selected || selected === "Back") return;
    const capsule = capsules[labels.indexOf(selected)];
    if (!capsule?.id) return;
    const keepBrowsing = await capsuleActions(context, capsule.id);
    if (!keepBrowsing) return;
  }
}

async function capsuleActions(context, id) {
  const detail = await runArcJson(["capsule", id, "--json"], context);
  if (!detail.ok) {
    await safeLog(detail.text || `ARC could not read capsule ${id}`, { level: "warning" });
    return true;
  }
  const capsule = detail.json.capsule || {};
  await safeLog(formatCapsule(capsule));
  const action = await session.ui.select("ARC capsule", ["View full", "Delete", "Share", "Back"]);
  if (!action || action === "Back") return true;
  if (action === "View full") {
    await safeLog(JSON.stringify(capsule, null, 2));
    return true;
  }
  if (action === "Delete") {
    const confirmed = await session.ui.confirm(`Delete ARC capsule "${capsule.title || id}"?`);
    if (!confirmed) return true;
    const deleted = await runArc(["capsules", "delete", id], context);
    await safeLog(deleted.text || `deleted ${id}`, { level: deleted.ok ? "info" : "warning" });
    return true;
  }
  if (action === "Share") {
    const shared = await runArc(["capsules", "share", id], context);
    await safeLog(shared.text || "ARC share output was empty", { level: shared.ok ? "info" : "warning" });
    return true;
  }
  return true;
}

function formatCapsule(capsule) {
  const lines = [
    `ARC capsule: ${capsule.title || capsule.id || "untitled"}`,
    `id: ${capsule.id || ""}`,
    `kind: ${capsule.kind || "workflow"} | scope: ${capsule.scope || "workspace"} | confidence: ${Math.round((capsule.confidence || 0) * 100)}%`
  ];
  if (capsule.summary) lines.push("", capsule.summary);
  if (Array.isArray(capsule.reuseWhen) && capsule.reuseWhen.length) {
    lines.push("", "Reuse when:");
    for (const item of capsule.reuseWhen.slice(0, 5)) lines.push(`- ${item}`);
  }
  if (capsule.nextRunInstruction) lines.push("", "Next:", capsule.nextRunInstruction);
  return lines.join("\n");
}

session = await joinSession({
  commands: [
    {
      name: "arc",
      description: "Open Agent Run Cache",
      handler: topMenu
    },
    {
      name: "arc-pause",
      description: "Pause or resume ARC injection",
      handler: quickPause
    },
    {
      name: "arc-judge",
      description: "Switch ARC judge model",
      handler: quickJudge
    }
  ]
});

if (process.env.ARC_EXTENSION_MARKER) {
  try {
    writeFileSync(process.env.ARC_EXTENSION_MARKER, JSON.stringify({
      joinedAt: new Date().toISOString(),
      sessionId: session.sessionId,
      capabilities: session.capabilities,
      commands: ["arc", "arc-pause", "arc-judge"]
    }, null, 2));
  } catch (error) {
    await safeLog(`ARC marker write failed: ${error?.message || String(error)}`, { level: "warning" });
  }
}
