#!/usr/bin/env node
const { copyFileSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } = require("node:fs");
const { dirname, join, resolve } = require("node:path");
const { spawnSync } = require("node:child_process");
const { arch, platform } = require("node:process");

const root = resolve(__dirname, "..");
const binDir = join(root, "bin");
const targetName = platform === "win32" ? "arc.exe" : "arc";
const target = join(binDir, targetName);
const portableTarget = join(binDir, "arc");
const zellijMarker = "0.44.3-arc-appliance.1";

function main() {
  if (process.argv.includes("--prepare")) {
    writePackagePlaceholder();
    return;
  }

  mkdirSync(binDir, { recursive: true });

  if (
    process.argv.includes("--postinstall") &&
    !process.env.AGENT_RUN_CACHE_INSTALL_BINARY &&
    !locatePackagedBinary()
  ) {
    writeUnsupportedPlaceholder();
    return;
  }

  const source = installSource();
  copyExecutable(source.path, target);
  if (target !== portableTarget) copyExecutable(source.path, portableTarget);
  const zellij = installPackagedZellij();
  writeFileSync(
    join(binDir, "arc-install.json"),
    `${JSON.stringify({ installedAt: new Date().toISOString(), source: source.label, binary: target, zellij }, null, 2)}\n`
  );
  console.log(`Agent Run Cache Rust binary installed at ${target}.`);
  console.log("Run arc setup, then use arc split, arc ui, or /arc inside Copilot.");
}

function writePackagePlaceholder() {
  mkdirSync(binDir, { recursive: true });
  rmSync(join(binDir, "arc-install.json"), { force: true });
  rmSync(join(binDir, "arc.exe"), { force: true });
  rmSync(join(binDir, "zellij"), { force: true });
  const body = `#!/usr/bin/env node
console.error("ARC native binary is not installed. Run \`npm rebuild arc-copilot\` or \`npm run build:rust\` to install it.");
process.exit(1);
`;
  writeFileSync(portableTarget, body);
  if (platform !== "win32") {
    require("node:fs").chmodSync(portableTarget, 0o755);
  }
  console.log(`Prepared ARC package placeholder at ${portableTarget}.`);
}

function writeUnsupportedPlaceholder() {
  rmSync(join(binDir, "arc-install.json"), { force: true });
  rmSync(join(binDir, "arc.exe"), { force: true });
  rmSync(join(binDir, "zellij"), { force: true });
  const body = `#!/usr/bin/env node
console.error("arc-copilot has no prebuilt binary for ${platformKey()} yet.");
console.error("v0.1.0 ships macOS builds (darwin-arm64, darwin-x64); Linux and Windows are coming.");
console.error("To build from source: install Rust and run 'npm run build:rust', or set AGENT_RUN_CACHE_INSTALL_BINARY to a prebuilt arc binary.");
process.exit(1);
`;
  writeFileSync(portableTarget, body);
  if (platform !== "win32") {
    require("node:fs").chmodSync(portableTarget, 0o755);
  }
  console.log(`arc-copilot: no prebuilt binary for ${platformKey()} yet (macOS-only in v0.1.0).`);
  console.log("Installed a placeholder; running 'arc' will explain how to build from source.");
}

function installPackagedZellij() {
  if (platform === "win32") {
    rmSync(join(binDir, "zellij"), { force: true });
    return { installed: false, reason: "Windows uses the documented Windows Terminal fallback." };
  }
  const override = process.env.AGENT_RUN_CACHE_INSTALL_ZELLIJ;
  let packaged;
  let zellijSource;
  if (override) {
    packaged = resolve(override);
    zellijSource = "env:AGENT_RUN_CACHE_INSTALL_ZELLIJ";
  } else {
    const depDir = optionalDepDir();
    const depZellij = depDir ? join(depDir, "zellij") : null;
    if (depZellij && existsSync(depZellij)) {
      packaged = depZellij;
      zellijSource = `optional-dep:arc-copilot-${platformKey()}`;
    } else {
      packaged = join(root, "prebuilds", platformKey(), "zellij");
      zellijSource = `prebuild:${platformKey()}`;
    }
  }

  if (override && !isApplianceZellij(packaged)) {
    fail(
      `AGENT_RUN_CACHE_INSTALL_ZELLIJ must point to Zellij ${zellijMarker}: ${packaged}`
    );
  }
  if (!override && !isApplianceZellij(packaged) && canBuildZellij()) {
    const build = spawnSync(
      process.execPath,
      [
        join(root, "scripts", "build-zellij-appliance.cjs"),
        "--target",
        platformKey(),
        "--out",
        packaged
      ],
      { cwd: root, stdio: "inherit", env: process.env }
    );
    if (build.status !== 0) {
      fail("could not build the ARC Zellij appliance.");
    }
  }
  if (!isApplianceZellij(packaged)) {
    fail(
      `the package does not include the required Zellij ${zellijMarker} build for ${platformKey()}`
    );
  }

  const destination = join(binDir, "zellij");
  copyExecutable(packaged, destination);
  return {
    installed: true,
    version: zellijMarker,
    source: zellijSource,
    binary: destination
  };
}

function canBuildZellij() {
  return (
    !process.argv.includes("--postinstall") &&
    existsSync(join(root, "scripts", "build-zellij-appliance.cjs")) &&
    existsSync(join(root, "patches", "zellij-0.44.3-arc-appliance.patch"))
  );
}

function isApplianceZellij(path) {
  if (!existsSync(path)) return false;
  const result = spawnSync(path, ["--version"], { encoding: "utf8" });
  return (
    result.status === 0 &&
    `${String(result.stdout || "")}\n${String(result.stderr || "")}`.includes(zellijMarker)
  );
}

function installSource() {
  const override = process.env.AGENT_RUN_CACHE_INSTALL_BINARY;
  if (override) {
    const path = resolve(override);
    if (!existsSync(path)) fail(`AGENT_RUN_CACHE_INSTALL_BINARY does not exist: ${path}`);
    return { path, label: "env:AGENT_RUN_CACHE_INSTALL_BINARY" };
  }

  const cargoToml = join(root, "Cargo.toml");
  if (!process.argv.includes("--postinstall") && existsSync(cargoToml)) {
    return buildFromCargo();
  }

  const packaged = locatePackagedBinary();
  if (packaged) return packaged;

  if (!existsSync(cargoToml)) {
    fail("Cargo.toml is missing and no packaged ARC binary was found.");
  }
  return buildFromCargo();
}

function locatePackagedBinary() {
  const candidates = (dir) => [join(dir, targetName), join(dir, "arc"), join(dir, "arc.exe")];
  const depDir = optionalDepDir();
  if (depDir) {
    const depBin = candidates(depDir).find((path) => existsSync(path));
    if (depBin) return { path: depBin, label: `optional-dep:arc-copilot-${platformKey()}` };
  }
  const prebuilt = candidates(join(root, "prebuilds", platformKey())).find((path) => existsSync(path));
  if (prebuilt) return { path: prebuilt, label: `prebuild:${platformKey()}` };
  return null;
}

function buildFromCargo() {
  const cargo = spawnSync("cargo", ["build", "--release"], {
    cwd: root,
    stdio: "inherit",
    env: process.env
  });
  if (cargo.status !== 0) {
    fail("cargo build --release failed and no packaged ARC binary was available.");
  }
  const built = join(root, "target", "release", targetName);
  if (!existsSync(built)) fail(`cargo completed but did not produce ${built}`);
  return { path: built, label: "cargo:release" };
}

function optionalDepDir() {
  const pkg = `arc-copilot-${platformKey()}`;
  try {
    return dirname(require.resolve(`${pkg}/package.json`, { paths: [root] }));
  } catch {
    return null;
  }
}

function platformKey() {
  const os = platform === "darwin" ? "darwin" : platform === "linux" ? "linux" : platform === "win32" ? "windows" : platform;
  const cpu = arch === "x64" ? "x64" : arch === "arm64" ? "arm64" : arch;
  return `${os}-${cpu}`;
}

function copyExecutable(from, to) {
  const tmp = `${to}.tmp-${process.pid}`;
  rmSync(tmp, { force: true });
  copyFileSync(from, tmp);
  if (platform !== "win32") {
    require("node:fs").chmodSync(tmp, 0o755);
  }
  renameSync(tmp, to);
}

function fail(message) {
  console.error(`ARC install failed: ${message}`);
  console.error("Set AGENT_RUN_CACHE_INSTALL_BINARY to a prebuilt arc binary, or install Rust/Cargo and retry.");
  process.exit(1);
}

main();
