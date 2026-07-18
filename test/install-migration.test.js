import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const installer = resolve("install.sh");

test("installer removes the legacy package before installing and repoints old native paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "arc-install-migration-"));
  const home = join(root, "home");
  const prefix = join(root, "prefix");
  const fakeBin = join(root, "fake-bin");
  const logPath = join(root, "npm.log");
  const npmRoot = join(prefix, "lib", "node_modules");
  const legacyPackage = join(npmRoot, "agent-run-cache");
  const legacyNativeBin = join(home, ".arc-copilot", "bin");
  const userBin = join(home, ".local", "bin");

  await mkdir(join(legacyPackage, "bin"), { recursive: true });
  await mkdir(join(prefix, "bin"), { recursive: true });
  await mkdir(legacyNativeBin, { recursive: true });
  await mkdir(userBin, { recursive: true });
  await mkdir(fakeBin, { recursive: true });
  await writeFile(join(legacyPackage, "package.json"), JSON.stringify({ name: "agent-run-cache", version: "2.1.0" }));
  await writeFile(join(legacyPackage, "bin", "arc"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  await symlink("../lib/node_modules/agent-run-cache/bin/arc", join(prefix, "bin", "arc"));
  await symlink("../lib/node_modules/agent-run-cache/bin/arc", join(prefix, "bin", "agent-run-cache"));
  await writeFile(join(legacyNativeBin, "arc"), "#!/bin/sh\necho legacy-native\n", { mode: 0o755 });
  await symlink(join(legacyNativeBin, "arc"), join(userBin, "arc"));

  const fakeNpm = join(fakeBin, "npm");
  await writeFile(fakeNpm, fakeNpmSource(), { mode: 0o755 });
  await chmod(fakeNpm, 0o755);

  try {
    const result = spawnSync("sh", [installer], {
      cwd: resolve("."),
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: home,
        PATH: [fakeBin, join(prefix, "bin"), userBin, process.env.PATH].join(":"),
        FAKE_NPM_PREFIX: prefix,
        FAKE_NPM_LOG: logPath,
        ARC_PACKAGE_SPEC: "arc-copilot@fixture"
      }
    });

    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const calls = (await readFile(logPath, "utf8")).trim().split("\n");
    const uninstall = calls.findIndex((line) => line === "uninstall -g agent-run-cache");
    const install = calls.findIndex((line) => line === "install -g arc-copilot@fixture --include=optional");
    assert.ok(uninstall >= 0, calls.join("\n"));
    assert.ok(install > uninstall, calls.join("\n"));
    await assert.rejects(readFile(join(legacyPackage, "package.json"), "utf8"));

    const canonical = join(prefix, "bin", "arc");
    assert.equal(await readlink(join(userBin, "arc")), canonical);
    assert.equal(await readlink(join(legacyNativeBin, "arc")), canonical);
    assert.match(result.stdout, /Desktop and Copilot share local cache data without sharing executables/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function fakeNpmSource() {
  return `#!/usr/bin/env node
const { appendFileSync, chmodSync, lstatSync, mkdirSync, rmSync, symlinkSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const args = process.argv.slice(2);
const prefix = process.env.FAKE_NPM_PREFIX;
appendFileSync(process.env.FAKE_NPM_LOG, args.join(" ") + "\\n");
if (args[0] === "root" && args[1] === "-g") {
  process.stdout.write(join(prefix, "lib", "node_modules") + "\\n");
  process.exit(0);
}
if (args[0] === "config" && args[1] === "get" && args[2] === "prefix") {
  process.stdout.write(prefix + "\\n");
  process.exit(0);
}
if (args[0] === "uninstall") {
  rmSync(join(prefix, "lib", "node_modules", "agent-run-cache"), { recursive: true, force: true });
  rmSync(join(prefix, "bin", "arc"), { force: true });
  process.exit(0);
}
if (args[0] === "install") {
  if (lstatSync(join(prefix, "bin", "agent-run-cache"), { throwIfNoEntry: false })) {
    process.stderr.write("stale legacy npm shim reached install\\n");
    process.exit(3);
  }
  const packageBin = join(prefix, "lib", "node_modules", "arc-copilot", "bin");
  mkdirSync(packageBin, { recursive: true });
  mkdirSync(join(prefix, "bin"), { recursive: true });
  const executable = join(packageBin, "arc");
  writeFileSync(executable, "#!/bin/sh\\nexit 0\\n");
  chmodSync(executable, 0o755);
  for (const command of ["arc", "agent-run-cache"]) {
    const link = join(prefix, "bin", command);
    rmSync(link, { force: true });
    symlinkSync("../lib/node_modules/arc-copilot/bin/arc", link);
  }
  process.exit(0);
}
process.stderr.write("unsupported fake npm call: " + args.join(" ") + "\\n");
process.exit(2);
`;
}
