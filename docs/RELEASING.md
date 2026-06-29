# Releasing arc-copilot

Two install channels ship from one set of build artifacts:

- **npm**: `arc-copilot` + five `arc-copilot-<target>` platform packages.
- **Shell one-liner**: `install.sh` / `install.ps1` download tarballs from the
  GitHub Release.

Both consume the same per-target binaries produced by `npm run build:release`.

## One-time setup

1. **npm names** — confirm these are available (or owned by you) on npmjs.com:
   `arc-copilot`, `arc-copilot-darwin-arm64`, `arc-copilot-darwin-x64`,
   `arc-copilot-linux-x64`, `arc-copilot-linux-arm64`, `arc-copilot-windows-x64`.
   Then `npm login`.
2. **Public releases** — the shell installers fetch from public GitHub Releases
   and `raw.githubusercontent.com/arc-cache/copilot/main/install.*`. The `copilot`
   repo (or a public releases mirror) must be public for those URLs to resolve.
   npm and the binaries themselves do not require this.
3. **Build toolchain** — Rust, plus `zig` and `cargo-zigbuild` for the Linux and
   Windows cross targets (`brew install zig` / `cargo install cargo-zigbuild`).

## Cutting a release

Run from a clean checkout on `main`.

1. **Bump the version** in `package.json`. Keep the five entries in
   `optionalDependencies` pinned to the *same* version — the platform packages
   are published at that version. (If you bump often, script this to avoid drift.)

2. **Build the per-target binaries and archives:**
   ```bash
   npm run build:release        # writes prebuilds/<target>/ and release/*.tar.gz|.zip
   ```

3. **Assemble the npm platform packages:**
   ```bash
   npm run build:npm            # writes npm/arc-copilot-<target>/ from prebuilds/
   ```

4. **Test, then publish all six packages** (platform packages first so the
   main package's optionalDependencies resolve):
   ```bash
   npm test
   for d in npm/arc-copilot-*; do (cd "$d" && npm publish --access public); done
   npm publish --access public  # the main arc-copilot package
   ```

5. **Create the GitHub Release** on tag `v<version>` and upload the archives from
   `release/` (`arc-<version>-<target>.tar.gz` and the Windows `.zip`). The
   installer scripts resolve the latest tag and expect exactly these asset names.

## Verifying an install

```bash
# npm (in a throwaway dir)
npm i -g arc-copilot && arc doctor --json

# shell
curl -fsSL https://raw.githubusercontent.com/arc-cache/copilot/main/install.sh | sh
```

`arc doctor --json` should report `split.zellijProvisioned: true` with a
`zellijPath` that sits next to the installed `arc` binary.

## Notes

- Package-manager and curl-pipe installs are not quarantined by macOS Gatekeeper
  or Windows SmartScreen, so no code signing or notarization is required for
  these channels. Only manual browser downloads of the release archives would
  trigger those warnings.
- Windows ships `arc.exe` only; `arc split` uses the Windows Terminal fallback,
  so the Windows package carries no `zellij`.
