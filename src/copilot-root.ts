import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export function resolveCopilotRoot(args: string[] = []): string | null {
  const explicit = optionValue(args, "--copilot-root") ?? process.env.AGENT_RUN_CACHE_COPILOT_ROOT;
  if (explicit) return resolve(explicit);
  for (const candidate of copilotRootCandidates()) {
    if (existsSync(join(candidate, "app.js"))) return candidate;
  }
  return null;
}

function copilotRootCandidates(): string[] {
  const candidates: string[] = [];
  candidates.push(...copilotCacheCandidates());
  const executable = findExecutable("copilot");
  if (executable) {
    const real = realpathSync(executable);
    candidates.push(dirname(real));
  }
  const npmRoot = spawnSync("npm", ["root", "-g"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  if (npmRoot.status === 0) candidates.push(join(npmRoot.stdout.trim(), "@github", "copilot"));
  return unique(candidates);
}

function copilotCacheCandidates(): string[] {
  const triples = platformTriples();
  const roots = [
    join(homedir(), "Library", "Caches", "copilot", "pkg"),
    join(homedir(), ".cache", "copilot", "pkg")
  ];
  const candidates: string[] = [];
  for (const root of roots) {
    for (const triple of triples) {
      const dir = join(root, triple);
      if (!existsSync(dir)) continue;
      for (const version of sortedVersionDirs(dir)) {
        candidates.push(join(dir, version));
      }
    }
  }
  return candidates;
}

function platformTriples(): string[] {
  const arch = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "x64" : process.arch;
  if (process.platform === "darwin") return [`darwin-${arch}`];
  if (process.platform === "linux") return [`linux-${arch}`, `linuxmusl-${arch}`];
  if (process.platform === "win32") return [`win32-${arch}`];
  return [`${process.platform}-${arch}`];
}

function sortedVersionDirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((name) => existsSync(join(dir, name, "app.js")))
      .sort(compareVersionsDesc);
  } catch {
    return [];
  }
}

function findExecutable(name: string): string | null {
  const suffixes = process.platform === "win32" ? ["", ".cmd", ".exe"] : [""];
  for (const dir of (process.env.PATH ?? "").split(process.platform === "win32" ? ";" : ":")) {
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

function optionValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  return args[index + 1];
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean).map((value) => resolve(value)))];
}

function compareVersionsDesc(left: string, right: string): number {
  const leftParts = left.split(".").map((part) => Number(part));
  const rightParts = right.split(".").map((part) => Number(part));
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index++) {
    const diff = (rightParts[index] || 0) - (leftParts[index] || 0);
    if (diff) return diff;
  }
  return right.localeCompare(left);
}
