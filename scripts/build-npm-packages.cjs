#!/usr/bin/env node
const { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync, chmodSync } = require("node:fs");
const { join, resolve } = require("node:path");

const root = resolve(__dirname, "..");
const prebuildsDir = join(root, "prebuilds");
const npmDir = join(root, "npm");
const version = require(join(root, "package.json")).version;

const targets = [
  { key: "darwin-arm64", os: "darwin", cpu: "arm64", binary: "arc", zellij: true },
  { key: "darwin-x64", os: "darwin", cpu: "x64", binary: "arc", zellij: true },
  { key: "linux-x64", os: "linux", cpu: "x64", binary: "arc", zellij: true },
  { key: "linux-arm64", os: "linux", cpu: "arm64", binary: "arc", zellij: true },
  { key: "windows-x64", os: "win32", cpu: "x64", binary: "arc.exe", zellij: false }
];

function main() {
  const selected = selectedTargets();
  const built = [];
  for (const target of selected) {
    const fromDir = join(prebuildsDir, target.key);
    const binSource = join(fromDir, target.binary);
    if (!existsSync(binSource)) {
      fail(`missing prebuilt binary for ${target.key}: ${binSource}. Run \`npm run build:release\` first.`);
    }
    const outDir = join(npmDir, `arc-copilot-${target.key}`);
    rmSync(outDir, { recursive: true, force: true });
    mkdirSync(outDir, { recursive: true });

    copyExecutable(binSource, join(outDir, target.binary), target.os !== "win32");
    const files = [target.binary, "LICENSE", "NOTICE"];
    if (target.zellij) {
      const zSource = join(fromDir, "zellij");
      if (!existsSync(zSource)) fail(`missing prebuilt zellij for ${target.key}: ${zSource}`);
      copyExecutable(zSource, join(outDir, "zellij"), true);
      copyFileSync(join(root, "licenses", "ZELLIJ-MIT.txt"), join(outDir, "ZELLIJ-MIT.txt"));
      files.push("zellij", "ZELLIJ-MIT.txt");
    }
    copyFileSync(join(root, "LICENSE"), join(outDir, "LICENSE"));
    copyFileSync(join(root, "NOTICE"), join(outDir, "NOTICE"));

    writeFileSync(
      join(outDir, "package.json"),
      `${JSON.stringify(packageJson(target, files), null, 2)}\n`
    );
    built.push({ package: `arc-copilot-${target.key}`, dir: outDir, files });
  }
  process.stdout.write(`${JSON.stringify({ version, built }, null, 2)}\n`);
}

function packageJson(target, files) {
  return {
    name: `arc-copilot-${target.key}`,
    version,
    description: `Prebuilt arc binary for ${target.key} (arc-copilot for GitHub Copilot CLI).`,
    license: "Apache-2.0",
    repository: { type: "git", url: "git+https://github.com/arc-cache/copilot.git" },
    os: [target.os],
    cpu: [target.cpu],
    files
  };
}

function selectedTargets() {
  const raw = option("--targets") || targets.map((t) => t.key).join(",");
  const names = new Set(raw.split(",").map((s) => s.trim()).filter(Boolean));
  const selected = targets.filter((t) => names.has(t.key));
  if (!selected.length) fail(`no known targets selected from: ${raw}`);
  return selected;
}

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function copyExecutable(from, to, exec) {
  copyFileSync(from, to);
  if (exec) chmodSync(to, 0o755);
}

function fail(message) {
  console.error(`ARC npm package build failed: ${message}`);
  process.exit(1);
}

main();
