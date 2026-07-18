import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface ArcRuntime {
  node: string;
  entrypoint: string;
  packageRoot: string;
  transient: boolean;
  transientReason?: string;
}

export function currentArcRuntime(): ArcRuntime {
  const entrypoint = join(dirname(fileURLToPath(import.meta.url)), "cli.js");
  const packageRoot = resolve(dirname(entrypoint), "..");
  const transientReason = transientRuntimeReason(entrypoint);
  return {
    node: process.execPath,
    entrypoint,
    packageRoot,
    transient: Boolean(transientReason),
    transientReason
  };
}

export function assertDurableArcRuntime(runtime = currentArcRuntime()): ArcRuntime {
  if (!existsSync(runtime.entrypoint)) {
    throw new Error(`ARC runtime entrypoint does not exist: ${runtime.entrypoint}`);
  }
  if (runtime.transient) {
    throw new Error([
      `ARC was launched from a transient npm cache (${runtime.transientReason}).`,
      "Install it durably with the migration-aware installer from https://github.com/arc-cache/copilot#install-or-upgrade, then run `arc plugin install` again.",
      "`npx arc-copilot <cmd>` is only for ad-hoc inspection commands, not persistent hooks."
    ].join(" "));
  }
  return runtime;
}

export function transientRuntimeReason(entrypoint: string): string | undefined {
  const normalized = entrypoint.replace(/\\/g, "/");
  const markers = [
    "/.npm/_npx/",
    "/_npx/",
    "/node_modules/.cache/",
    "/.cache/pnpm/dlx/",
    "/pnpm/dlx/"
  ];
  return markers.find((marker) => normalized.includes(marker));
}

export interface PathExecutable {
  found: boolean;
  path?: string;
}

export function resolveArcOnPath(envPath = process.env.PATH ?? "", platform = process.platform): PathExecutable {
  const executable = findExecutable("arc", envPath, platform);
  return executable ? { found: true, path: executable } : { found: false };
}

export function findExecutable(name: string, envPath = process.env.PATH ?? "", platform = process.platform): string | null {
  const suffixes = platform === "win32" ? ["", ".cmd", ".ps1", ".exe"] : [""];
  const separator = platform === "win32" ? ";" : ":";
  for (const dir of envPath.split(separator)) {
    if (!dir) continue;
    for (const suffix of suffixes) {
      const candidate = join(dir, `${name}${suffix}`);
      try {
        if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
      } catch {
        continue;
      }
    }
  }
  return null;
}

export function npmGlobalRoot(): string | null {
  const result = spawnSync("npm", ["root", "-g"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  return result.status === 0 ? result.stdout.trim() : null;
}
