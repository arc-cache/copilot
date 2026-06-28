#!/usr/bin/env node
const {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync
} = require("node:fs");
const { delimiter, dirname, join, resolve } = require("node:path");
const { arch, platform } = require("node:process");
const { spawnSync } = require("node:child_process");

const root = resolve(__dirname, "..");
const version = "0.44.3";
const revision = "55a2121b73dce4be624cda425a960e893000777c";
const marker = `${version}-arc-appliance.1`;
const patch = join(root, "patches", `zellij-${version}-arc-appliance.patch`);
const source = join(root, "target", "zellij-appliance", version, "source");
const cargoTarget = join(root, "target", "zellij-appliance", version, "build");

const targets = [
  { key: "darwin-arm64", triple: "aarch64-apple-darwin" },
  { key: "darwin-x64", triple: "x86_64-apple-darwin" },
  { key: "linux-x64", triple: "x86_64-unknown-linux-musl", zigbuild: true },
  { key: "linux-arm64", triple: "aarch64-unknown-linux-musl", zigbuild: true }
];

function main() {
  const target = selectedTarget();
  const output = option("--out")
    ? resolve(option("--out"))
    : join(root, "prebuilds", target.key, "zellij");

  prepareSource();
  run("rustup", ["target", "add", target.triple], source);
  if (target.zigbuild && (!commandExists("cargo-zigbuild") || !commandExists("zig"))) {
    fail(
      `building ${target.key} requires cargo-zigbuild and zig; install them or build on the target platform`
    );
  }

  const buildArgs = [
    "--release",
    "--no-default-features",
    "--features",
    "plugins_from_target,vendored_curl",
    "--target",
    target.triple
  ];
  const args = target.zigbuild ? ["zigbuild", ...buildArgs] : ["build", ...buildArgs];
  run("cargo", args, source, { CARGO_TARGET_DIR: cargoTarget });

  const built = join(cargoTarget, target.triple, "release", "zellij");
  if (!existsSync(built)) fail(`expected build output missing: ${built}`);
  if (!readFileSync(built).includes(Buffer.from(marker))) {
    fail(`built zellij does not contain the ARC appliance marker ${marker}`);
  }

  copyExecutable(built, output);
  process.stdout.write(
    `${JSON.stringify({ version: marker, revision, target: target.key, binary: output }, null, 2)}\n`
  );
}

function selectedTarget() {
  const requested = option("--target") || nativeTarget();
  const target = targets.find(
    (candidate) => candidate.key === requested || candidate.triple === requested
  );
  if (!target) fail(`unsupported zellij appliance target: ${requested}`);
  return target;
}

function nativeTarget() {
  const os =
    platform === "darwin"
      ? "darwin"
      : platform === "linux"
        ? "linux"
        : platform;
  const cpu = arch === "arm64" ? "arm64" : arch === "x64" ? "x64" : arch;
  return `${os}-${cpu}`;
}

function prepareSource() {
  if (!existsSync(join(source, ".git"))) {
    rmSync(source, { force: true, recursive: true });
    mkdirSync(resolve(source, ".."), { recursive: true });
    run(
      "git",
      [
        "clone",
        "--depth",
        "1",
        "--branch",
        `v${version}`,
        "https://github.com/zellij-org/zellij.git",
        source
      ],
      root
    );
  }

  const actualRevision = capture("git", ["rev-parse", "HEAD"], source);
  if (actualRevision !== revision) {
    fail(`zellij source revision mismatch: expected ${revision}, got ${actualRevision}`);
  }

  if (check("git", ["apply", "--reverse", "--check", patch], source)) return;
  if (!check("git", ["diff", "--quiet"], source)) {
    fail(`zellij source has unexpected tracked changes: ${source}`);
  }
  run("git", ["apply", "--check", patch], source);
  run("git", ["apply", patch], source);
}

function copyExecutable(from, to) {
  mkdirSync(dirname(to), { recursive: true });
  const temp = `${to}.tmp-${process.pid}`;
  rmSync(temp, { force: true });
  copyFileSync(from, temp);
  chmodSync(temp, 0o755);
  renameSync(temp, to);
}

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function run(command, args, cwd, extraEnv = {}) {
  const result = spawnSync(command, args, {
    cwd,
    stdio: "inherit",
    env: { ...process.env, ...extraEnv }
  });
  if (result.status !== 0) {
    fail(`${command} ${args.join(" ")} failed with ${result.status ?? "no status"}`);
  }
}

function capture(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    fail(`${command} ${args.join(" ")} failed: ${String(result.stderr || "").trim()}`);
  }
  return result.stdout.trim();
}

function check(command, args, cwd) {
  return spawnSync(command, args, { cwd, stdio: "ignore" }).status === 0;
}

function commandExists(command) {
  return String(process.env.PATH || "")
    .split(delimiter)
    .filter(Boolean)
    .some((dir) => existsSync(join(dir, command)));
}

function fail(message) {
  console.error(`ARC zellij appliance build failed: ${message}`);
  process.exit(1);
}

main();
