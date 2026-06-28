#!/usr/bin/env node
const { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } = require("node:fs");
const { createHash } = require("node:crypto");
const { delimiter } = require("node:path");
const { join, resolve } = require("node:path");
const { spawnSync } = require("node:child_process");

const root = resolve(__dirname, "..");
const prebuildsDir = join(root, "prebuilds");
const releaseDir = join(root, "release");
const zellijVersion = "0.44.3-arc-appliance.1";

const targets = [
  { key: "darwin-arm64", triple: "aarch64-apple-darwin", binary: "arc", archive: "tar.gz" },
  { key: "darwin-x64", triple: "x86_64-apple-darwin", binary: "arc", archive: "tar.gz" },
  { key: "linux-x64", triple: "x86_64-unknown-linux-musl", binary: "arc", archive: "tar.gz", zigbuild: true },
  { key: "linux-arm64", triple: "aarch64-unknown-linux-musl", binary: "arc", archive: "tar.gz", zigbuild: true },
  { key: "windows-x64", triple: "x86_64-pc-windows-gnu", binary: "arc.exe", archive: "zip", zigbuild: true }
];

function main() {
  const selected = selectedTargets();
  mkdirSync(prebuildsDir, { recursive: true });
  mkdirSync(releaseDir, { recursive: true });
  const built = [];
  for (const target of selected) {
    run("rustup", ["target", "add", target.triple]);
    buildTarget(target);
    const source = join(root, "target", target.triple, "release", target.binary);
    if (!existsSync(source)) fail(`expected build output missing: ${source}`);
    const outDir = join(prebuildsDir, target.key);
    mkdirSync(outDir, { recursive: true });
    const out = join(outDir, target.binary);
    copyFileSync(source, out);
    if (process.platform !== "win32") {
      require("node:fs").chmodSync(out, 0o755);
    }
    const zellij = provisionZellij(target, outDir);
    const archive = writeArchive(target, outDir, zellij);
    built.push({
      target: target.key,
      triple: target.triple,
      binary: out,
      zellij,
      archive,
      bytes: statSync(out).size
    });
  }
  process.stdout.write(`${JSON.stringify({ built }, null, 2)}\n`);
}

function buildTarget(target) {
  if (target.zigbuild) {
    if (!commandExists("zig") || !commandExists("cargo-zigbuild")) {
      fail(`building ${target.key} requires zig and cargo-zigbuild. Install with \`brew install zig\` and \`cargo install cargo-zigbuild --locked\`, or set ARC_RELEASE_TARGETS to installed native targets.`);
    }
    run("cargo", ["zigbuild", "--release", "--target", target.triple]);
    return;
  }
  run("cargo", ["build", "--release", "--target", target.triple]);
}

function selectedTargets() {
  const raw = option("--targets") || process.env.ARC_RELEASE_TARGETS || targets.map((target) => target.key).join(",");
  const names = new Set(raw.split(",").map((item) => item.trim()).filter(Boolean));
  const selected = targets.filter((target) => names.has(target.key) || names.has(target.triple));
  if (!selected.length) {
    fail(`no known targets selected from: ${raw}`);
  }
  return selected;
}

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function writeArchive(target, sourceDir, zellij) {
  const base = `arc-${packageVersion()}-${target.key}`;
  if (target.archive === "zip") {
    const archive = join(releaseDir, `${base}.zip`);
    rmSync(archive, { force: true });
    run("zip", ["-j", archive, join(sourceDir, target.binary)]);
    return archive;
  }
  const archive = join(releaseDir, `${base}.tar.gz`);
  rmSync(archive, { force: true });
  const files = [target.binary];
  if (zellij) files.push("zellij");
  const args = ["-czf", archive, "-C", sourceDir, ...files];
  if (zellij) {
    args.push("-C", root, "licenses/ZELLIJ-MIT.txt");
  }
  run("tar", args);
  return archive;
}

function provisionZellij(target, outDir) {
  if (target.key === "windows-x64") return null;
  const binary = join(outDir, "zellij");
  run(process.execPath, [
    join(root, "scripts", "build-zellij-appliance.cjs"),
    "--target",
    target.triple,
    "--out",
    binary
  ]);
  return {
    version: zellijVersion,
    binary,
    bytes: statSync(binary).size,
    sha256: sha256(binary)
  };
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function packageVersion() {
  return require(join(root, "package.json")).version;
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit", env: process.env });
  if (result.status !== 0) {
    fail(`${command} ${args.join(" ")} failed with ${result.status ?? "no status"}`);
  }
}

function commandExists(command) {
  const paths = String(process.env.PATH || "").split(delimiter).filter(Boolean);
  const names = process.platform === "win32" ? [command, `${command}.exe`, `${command}.cmd`, `${command}.bat`] : [command];
  return paths.some((dir) => names.some((name) => existsSync(join(dir, name))));
}

function fail(message) {
  console.error(`ARC release build failed: ${message}`);
  process.exit(1);
}

main();
