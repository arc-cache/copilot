import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { writeActivation } from "./install.js";
import { activationPath, arcHome, copilotUserExtensionsDir, workspaceRoot } from "./paths.js";
import { assertDurableArcRuntime, currentArcRuntime, type ArcRuntime } from "./runtime.js";
import { resolveCopilotRoot } from "./copilot-root.js";

const EXTENSION_NAME = "agent-run-cache";
const EXTENSION_SENTINEL = "agent-run-cache/copilot-sdk-extension/v1";

export interface CopilotSdkExtensionInstall {
  activationPath: string;
  projectExtensionPath: string;
  userExtensionPath: string;
  runtime: ArcRuntime;
}

export interface CopilotSdkExtensionStatus {
  installed: boolean;
  activated: boolean;
  host: CopilotSdkExtensionHostStatus;
  activationPath: string;
  projectExtensionPath: string;
  projectInstalled: boolean;
  projectRuntimePinned: boolean;
  userExtensionPath: string;
  userInstalled: boolean;
  userRuntimePinned: boolean;
  runtime: ArcRuntime;
  reason?: string;
}

export interface CopilotSdkExtensionHostStatus {
  copilotRoot?: string;
  extensionAvailability?: "on" | "off" | "experimental" | "team" | "staff" | "staff-or-experimental" | "unknown";
  extensionFeatureFlag?: boolean;
  extensionDiscoveryPresent: boolean;
  extensionModeDefault?: "load_and_augment" | "load_only" | "disabled";
  experimentalFlagPresent?: boolean;
  experimentalLoadsExtensionsLikely?: boolean;
  canvasesApiPresent: boolean;
  sdkCanvasApiPresent: boolean;
  likelyLoadsExtensions: boolean;
  reason?: string;
}

export async function installCopilotSdkExtension(workspace = workspaceRoot()): Promise<CopilotSdkExtensionInstall> {
  const runtime = assertDurableArcRuntime(currentArcRuntime());
  const activation = await writeActivation(workspace, runtime, "sdk-extension");
  const projectExtensionPath = projectCopilotExtensionPath(workspace);
  const userExtensionPath = userCopilotExtensionPath();
  await Promise.all([
    writeExtension(projectExtensionPath, runtime),
    writeExtension(userExtensionPath, runtime)
  ]);
  return { activationPath: activation, projectExtensionPath, userExtensionPath, runtime };
}

export async function copilotSdkExtensionStatus(workspace = workspaceRoot()): Promise<CopilotSdkExtensionStatus> {
  const runtime = currentArcRuntime();
  const projectExtensionPath = projectCopilotExtensionPath(workspace);
  const userExtensionPath = userCopilotExtensionPath();
  const [project, user, host] = await Promise.all([
    inspectExtension(projectExtensionPath, runtime),
    inspectExtension(userExtensionPath, runtime),
    inspectCopilotExtensionHost()
  ]);
  const activePath = activationPath(workspace);
  const activated = existsSync(activePath);
  const installed = activated && (project.installed || user.installed);
  return {
    installed,
    activated,
    host,
    activationPath: activePath,
    projectExtensionPath,
    projectInstalled: project.installed,
    projectRuntimePinned: project.runtimePinned,
    userExtensionPath,
    userInstalled: user.installed,
    userRuntimePinned: user.runtimePinned,
    runtime,
    reason: installed ? undefined : extensionReason(activated, project, user)
  };
}

export async function inspectCopilotExtensionHost(args: string[] = []): Promise<CopilotSdkExtensionHostStatus> {
  const root = resolveCopilotRoot(args);
  if (!root) {
    return {
      extensionDiscoveryPresent: false,
      canvasesApiPresent: false,
      sdkCanvasApiPresent: false,
      likelyLoadsExtensions: false,
      reason: "Could not find the installed @github/copilot package."
    };
  }
  const appJs = join(root, "app.js");
  if (!existsSync(appJs)) {
    return {
      copilotRoot: root,
      extensionDiscoveryPresent: false,
      canvasesApiPresent: false,
      sdkCanvasApiPresent: false,
      likelyLoadsExtensions: false,
      reason: `Copilot app.js was not found under ${root}.`
    };
  }
  try {
    const source = await readFile(appJs, "utf8");
    const extensionDiscoveryPresent = source.includes("extension_bootstrap.mjs")
      && source.includes("extensionDiscoverAll")
      && source.includes(".github/extensions");
    const extensionAvailability = extensionAvailabilityFromBundle(source);
    const extensionFeatureFlag = extensionFeatureFlagDefault(extensionAvailability);
    const extensionModeDefault = extensionModeDefaultFromBundle(source);
    const experimentalFlagPresent = source.includes("--experimental");
    const canvasesApiPresent = source.includes("list_canvas_capabilities")
      && source.includes("open_canvas")
      && source.includes("invoke_canvas_action");
    const sdkCanvasApiPresent = await inspectSdkCanvasApi(root);
    const likelyLoadsExtensions = extensionDiscoveryPresent && extensionFeatureFlag !== false && extensionModeDefault !== "disabled";
    const experimentalLoadsExtensionsLikely = extensionDiscoveryPresent
      && experimentalFlagPresent
      && (extensionAvailability === "experimental" || extensionAvailability === "staff-or-experimental")
      && extensionModeDefault !== "disabled";
    return {
      copilotRoot: root,
      extensionAvailability,
      extensionFeatureFlag,
      extensionDiscoveryPresent,
      extensionModeDefault,
      experimentalFlagPresent,
      experimentalLoadsExtensionsLikely,
      canvasesApiPresent,
      sdkCanvasApiPresent,
      likelyLoadsExtensions,
      reason: likelyLoadsExtensions ? undefined : extensionHostReason(extensionDiscoveryPresent, extensionAvailability, extensionModeDefault, experimentalLoadsExtensionsLikely)
    };
  } catch (error) {
    return {
      copilotRoot: root,
      extensionDiscoveryPresent: false,
      canvasesApiPresent: false,
      sdkCanvasApiPresent: false,
      likelyLoadsExtensions: false,
      reason: String(error)
    };
  }
}

export function projectCopilotExtensionPath(workspace = workspaceRoot()): string {
  return join(workspace, ".github", "extensions", EXTENSION_NAME, "extension.mjs");
}

export function userCopilotExtensionPath(): string {
  return join(copilotUserExtensionsDir(), EXTENSION_NAME, "extension.mjs");
}

async function writeExtension(file: string, runtime: ArcRuntime): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, extensionSource(runtime), "utf8");
  await chmod(file, 0o755).catch(() => undefined);
}

async function inspectExtension(file: string, runtime: ArcRuntime): Promise<{ installed: boolean; runtimePinned: boolean; reason?: string }> {
  if (!existsSync(file)) return { installed: false, runtimePinned: false, reason: "missing extension.mjs" };
  try {
    const source = await readFile(file, "utf8");
    const installed = source.includes(EXTENSION_SENTINEL) && source.includes("joinSession");
    const runtimePinned = installed && source.includes(JSON.stringify(runtime.node)) && source.includes(JSON.stringify(runtime.entrypoint));
    return { installed, runtimePinned, reason: installed ? undefined : "extension file is not ARC's SDK extension" };
  } catch (error) {
    return { installed: false, runtimePinned: false, reason: String(error) };
  }
}

function extensionReason(
  activated: boolean,
  project: { installed: boolean; reason?: string },
  user: { installed: boolean; reason?: string }
): string {
  if (!activated) return "workspace is not activated - install the Copilot plugin with arc plugin install, then launch Copilot normally";
  if (!project.installed && !user.installed) return `missing SDK extension (${project.reason ?? user.reason ?? "unknown"})`;
  return "SDK extension not installed";
}

function extensionAvailabilityFromBundle(source: string): CopilotSdkExtensionHostStatus["extensionAvailability"] {
  const match = source.match(/EXTENSIONS:\{availability:"([^"]+)"/);
  if (!match) return undefined;
  const value = match[1];
  if (value === "on" || value === "off" || value === "experimental" || value === "team" || value === "staff" || value === "staff-or-experimental") {
    return value;
  }
  return "unknown";
}

function extensionFeatureFlagDefault(availability: CopilotSdkExtensionHostStatus["extensionAvailability"]): boolean | undefined {
  if (availability === "on") return true;
  if (availability === "off" || availability === "experimental" || availability === "team" || availability === "staff" || availability === "staff-or-experimental") return false;
  return undefined;
}

function extensionModeDefaultFromBundle(source: string): CopilotSdkExtensionHostStatus["extensionModeDefault"] {
  const match = source.match(/function BV\([^)]*\)\{return [^?]+\.extensions\?\.mode\?\?"(load_and_augment|load_only|disabled)"\}/);
  if (!match) return undefined;
  return match[1] as CopilotSdkExtensionHostStatus["extensionModeDefault"];
}

function extensionHostReason(
  discovery: boolean,
  availability: CopilotSdkExtensionHostStatus["extensionAvailability"],
  mode: CopilotSdkExtensionHostStatus["extensionModeDefault"],
  experimentalLoadsExtensionsLikely?: boolean
): string | undefined {
  if (!discovery) return "Installed Copilot bundle does not expose SDK extension discovery.";
  if (experimentalLoadsExtensionsLikely) return "Installed Copilot bundle gates SDK extensions behind experimental mode; launch with --experimental for SDK primary, with JSON hooks as fallback.";
  if (availability && availability !== "on") return `Installed Copilot bundle gates SDK extensions behind ${availability} availability.`;
  if (mode === "disabled") return "Copilot extension mode defaults to disabled.";
  if (availability === undefined) return "Could not determine Copilot's EXTENSIONS feature flag from the installed bundle.";
  return undefined;
}

async function inspectSdkCanvasApi(root: string): Promise<boolean> {
  try {
    const [extensionTypes, canvasTypes, sessionTypes] = await Promise.all([
      readFile(join(root, "copilot-sdk", "extension.d.ts"), "utf8").catch(() => ""),
      readFile(join(root, "copilot-sdk", "canvas.d.ts"), "utf8").catch(() => ""),
      readFile(join(root, "copilot-sdk", "types.d.ts"), "utf8").catch(() => "")
    ]);
    return extensionTypes.includes("createCanvas")
      && canvasTypes.includes("function createCanvas")
      && sessionTypes.includes("canvases?: Canvas[]")
      && sessionTypes.includes("requestCanvasRenderer?: boolean");
  } catch {
    return false;
  }
}

function extensionSource(runtime: ArcRuntime): string {
  return `// ${EXTENSION_SENTINEL}
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import * as copilotSdk from "@github/copilot-sdk/extension";

const { joinSession, createCanvas } = copilotSdk;

const ARC_RUNTIME = ${JSON.stringify({
    node: runtime.node,
    entrypoint: runtime.entrypoint,
    packageRoot: runtime.packageRoot,
    arcHome: arcHome()
  }, null, 2)};

let session;
let canvasServerPromise;
const captured = [];
const injectionPlans = [];

function capture(kind, payload) {
  captured.push({ kind, at: new Date().toISOString(), payload });
  if (captured.length > 2000) captured.splice(0, captured.length - 2000);
}

function runArc(args, input, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const child = spawn(ARC_RUNTIME.node, [ARC_RUNTIME.entrypoint, "extension", ...args], {
      cwd: process.cwd(),
      env: { ...process.env, AGENT_RUN_CACHE_EXTENSION: "1" },
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      child.kill("SIGTERM");
      resolve({ ok: false, error: "ARC command timed out", stderr: stderr.slice(0, 1000) });
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
      if (stdout.length > 2 * 1024 * 1024) stdout = stdout.slice(-2 * 1024 * 1024);
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
      if (stderr.length > 1024 * 1024) stderr = stderr.slice(-1024 * 1024);
    });
    child.on("error", (error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ ok: false, error: error.message || String(error), stderr: stderr.slice(0, 1000) });
    });
    child.on("exit", (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (code !== 0) {
        resolve({ ok: false, error: "ARC command failed", status: code, stderr: stderr.slice(0, 1000) });
        return;
      }
      const text = String(stdout || "").trim();
      if (!text) {
        resolve({ ok: true });
        return;
      }
      try {
        resolve(JSON.parse(text));
      } catch (parseError) {
        resolve({ ok: false, error: "ARC returned invalid JSON", stdout: text.slice(0, 1000), parseError: String(parseError) });
      }
    });
    child.stdin.end(JSON.stringify(input ?? {}));
  });
}

function hasCanvasSupport(value) {
  return !!(value && value.ui && value.ui.canvases);
}

async function ensureArcCanvasServer() {
  if (canvasServerPromise) return canvasServerPromise;
  canvasServerPromise = new Promise((resolve, reject) => {
    const server = createServer(async (req, res) => {
      const requestUrl = new URL(req.url || "/", "http://127.0.0.1");
      if (requestUrl.pathname === "/data") {
        const result = await runArc(["canvas-data"], { capabilities: session?.capabilities, workspacePath: session?.workspacePath }, 8000);
        res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify(result));
        return;
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(arcCanvasHtml());
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("ARC canvas server did not bind to a TCP port"));
        return;
      }
      resolve("http://127.0.0.1:" + address.port + "/");
    });
  });
  return canvasServerPromise;
}

function arcCanvasHtml() {
  return \`<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>ARC</title>
  <style>
    :root { color-scheme: dark; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; background: #0d1117; color: #d1d7e0; }
    body { margin: 0; padding: 18px; }
    header { display: flex; gap: 12px; align-items: baseline; border-bottom: 1px solid #30363d; padding-bottom: 12px; margin-bottom: 16px; }
    h1 { font-size: 18px; margin: 0; }
    .muted { color: #8b949e; }
    .grid { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); }
    section { border: 1px solid #30363d; border-radius: 6px; padding: 12px; }
    h2 { font-size: 14px; margin: 0 0 10px; }
    .item { margin: 0 0 10px; }
    .title { color: #f0f6fc; }
    pre { white-space: pre-wrap; word-break: break-word; margin: 0; }
  </style>
</head>
<body>
  <header><h1>ARC</h1><span id="meta" class="muted">loading</span></header>
  <main class="grid">
    <section><h2>Capsules</h2><div id="capsules"></div></section>
    <section><h2>Activity</h2><div id="events"></div></section>
  </main>
  <script>
    async function refresh() {
      const response = await fetch('/data', { cache: 'no-store' });
      const data = await response.json();
      const model = data.model || data;
      document.getElementById('meta').textContent = (model.status?.capsuleCount || 0) + ' capsules | ' + (model.status?.eventCount || 0) + ' events';
      document.getElementById('capsules').innerHTML = (model.capsules || []).slice(0, 12).map(c =>
        '<div class="item"><div class="title">' + escapeHtml(c.title || c.id) + '</div><div class="muted">' + escapeHtml(c.summary || '') + '</div></div>'
      ).join('') || '<span class="muted">No capsules</span>';
      document.getElementById('events').innerHTML = (model.recentEvents || []).slice(0, 12).map(e =>
        '<div class="item"><div class="title">' + escapeHtml(e.type || '') + '</div><div class="muted">' + escapeHtml(e.detail || e.title || '') + '</div></div>'
      ).join('') || '<span class="muted">No recent activity</span>';
    }
    function escapeHtml(value) {
      return String(value).replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
    }
    refresh().catch(error => { document.body.innerHTML = '<pre>' + escapeHtml(error.stack || error.message || error) + '</pre>'; });
    setInterval(refresh, 2000);
  </script>
</body>
</html>\`;
}

async function logNotice(result, fallbackLevel = "info") {
  if (!session || !result) return;
  const notices = Array.isArray(result.notices) ? result.notices : result.notice ? [result.notice] : [];
  for (const notice of notices) {
    if (!notice) continue;
    await session.log(String(notice), result.logOptions || { level: result.level || fallbackLevel }).catch(() => {});
  }
}

const config = {
  hooks: {
    onSessionStart: async (input, invocation) => {
      capture("hook.sessionStart", { input, invocation });
      const result = await runArc(["hook", "session-start"], { input, invocation, capabilities: session?.capabilities, workspacePath: session?.workspacePath });
      await logNotice(result);
      return result.hookResult || {};
    },
    onUserPromptSubmitted: async (input, invocation) => {
      capture("hook.userPromptSubmitted", { input, invocation });
      const result = await runArc(["hook", "user-prompt"], { input, invocation, capabilities: session?.capabilities, workspacePath: session?.workspacePath });
      if (result.plan) injectionPlans.push(result.plan);
      await logNotice(result);
      return result.hookResult || {};
    },
    onPreToolUse: async (input, invocation) => {
      capture("hook.preToolUse", { input, invocation });
      return {};
    },
    onPostToolUse: async (input, invocation) => {
      capture("hook.postToolUse", { input, invocation });
      return {};
    },
    onErrorOccurred: async (input, invocation) => {
      capture("hook.errorOccurred", { input, invocation });
      return {};
    },
    onSessionEnd: async (input, invocation) => {
      capture("hook.sessionEnd", { input, invocation });
      const result = await runArc(["session-end"], {
        input,
        invocation,
        captured,
        injectionPlans,
        capabilities: session?.capabilities,
        workspacePath: session?.workspacePath
      }, 60000);
      await logNotice(result);
      return result.hookResult || {};
    }
  },
  commands: [
    {
      name: "arc",
      description: "Show Agent Run Cache status",
      handler: async (context) => {
        const result = await runArc(["command", "arc"], { context, capabilities: session?.capabilities, workspacePath: session?.workspacePath });
        await session?.log(String(result.text || result.notice || "ARC status unavailable"), { level: result.level || "info" }).catch(() => {});
      }
    },
    {
      name: "arc-status",
      description: "Show Agent Run Cache status",
      handler: async (context) => {
        const result = await runArc(["command", "arc-status"], { context, capabilities: session?.capabilities, workspacePath: session?.workspacePath });
        await session?.log(String(result.text || result.notice || "ARC status unavailable"), { level: result.level || "info" }).catch(() => {});
      }
    }
  ]
};

if (typeof createCanvas === "function") {
  config.extensionInfo = { source: "agent-run-cache", name: "agent-run-cache" };
  config.requestCanvasRenderer = true;
  config.canvases = [
    createCanvas({
      id: "arc",
      displayName: "ARC",
      description: "Open Agent Run Cache status, capsules, and recent activity.",
      actions: [
        {
          name: "refresh",
          description: "Return current ARC status and recent activity as JSON.",
          handler: async () => {
            const result = await runArc(["canvas-data"], { capabilities: session?.capabilities, workspacePath: session?.workspacePath }, 8000);
            return JSON.stringify(result.model || result);
          }
        }
      ],
      open: async (ctx) => {
        const supported = Boolean(ctx?.host?.capabilities?.canvases) || hasCanvasSupport(session?.capabilities);
        if (!supported) {
          return { title: "ARC", status: "Canvas rendering is not available in this Copilot host." };
        }
        const url = await ensureArcCanvasServer();
        return { url, title: "ARC", status: "local" };
      }
    })
  ];
}

session = await joinSession(config);
const loaded = await runArc(["loaded"], { sessionId: session.sessionId, capabilities: session.capabilities, workspacePath: session.workspacePath });
if (loaded.active) {
  await session.log(loaded.notice || "ARC extension loaded", { ephemeral: true }).catch(() => {});
}
session.on((event) => capture("event", event));
`;
}
