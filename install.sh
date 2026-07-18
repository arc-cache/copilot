#!/bin/sh
# ARC for GitHub Copilot CLI installer and upgrade migrator (macOS + Linux).
#
#   curl -fsSL https://raw.githubusercontent.com/arc-cache/copilot/main/install.sh | sh
#
# Env overrides:
#   ARC_VERSION        install a specific published version (default: latest)
#   ARC_PACKAGE_SPEC   install an explicit npm spec (release verification only)
#   ARC_INSTALL_DIR    legacy native install location to reconcile
set -eu

PACKAGE="arc-copilot"
LEGACY_PACKAGE="agent-run-cache"
LEGACY_INSTALL_DIR="${ARC_INSTALL_DIR:-$HOME/.arc-copilot}"

err() { printf 'arc install: %s\n' "$1" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

require_runtime() {
  have node || err "Node.js 22 or newer is required"
  have npm || err "npm is required"
  major=$(node -p 'Number(process.versions.node.split(".")[0])')
  [ "$major" -ge 22 ] || err "Node.js 22 or newer is required (found $(node --version))"
}

package_spec() {
  if [ -n "${ARC_PACKAGE_SPEC:-}" ]; then
    printf '%s' "$ARC_PACKAGE_SPEC"
  elif [ -n "${ARC_VERSION:-}" ]; then
    printf '%s@%s' "$PACKAGE" "${ARC_VERSION#v}"
  else
    printf '%s@latest' "$PACKAGE"
  fi
}

is_arc_target() {
  target=$1
  case "$target" in
    *"/node_modules/agent-run-cache/"* | *"/node_modules/arc-copilot/"* | "$LEGACY_INSTALL_DIR/bin/arc" | "$LEGACY_INSTALL_DIR/bin/agent-run-cache")
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

migrate_legacy_npm_package() {
  legacy_root="$(npm root -g)/$LEGACY_PACKAGE"
  if [ ! -e "$legacy_root" ] && [ ! -L "$legacy_root" ]; then
    return 0
  fi
  printf 'Migrating legacy global %s installation...\n' "$LEGACY_PACKAGE"
  npm uninstall -g "$LEGACY_PACKAGE" >/dev/null || err "could not remove the legacy global $LEGACY_PACKAGE package"
}

clear_stale_legacy_npm_links() {
  prefix=$1
  for command in arc agent-run-cache; do
    path="$prefix/bin/$command"
    [ -L "$path" ] || continue
    target=$(readlink "$path" 2>/dev/null || true)
    case "$target" in
      *"/node_modules/agent-run-cache/"*)
        rm -f "$path" || err "could not remove stale legacy ARC link: $path"
        ;;
    esac
  done
}

repoint_link() {
  path=$1
  canonical=$2
  [ -L "$path" ] || return 0
  [ "$path" -ef "$canonical" ] && return 0
  target=$(readlink "$path" 2>/dev/null || true)
  if is_arc_target "$target"; then
    rm -f "$path" || err "could not replace legacy ARC link: $path"
    ln -s "$canonical" "$path" || err "could not create ARC link: $path"
  fi
}

reconcile_legacy_paths() {
  canonical=$1

  # The old native installer placed a real binary here and added this directory
  # to PATH. Turn it into a forwarder so it cannot shadow npm upgrades.
  for command in arc agent-run-cache; do
    legacy="$LEGACY_INSTALL_DIR/bin/$command"
    if [ -e "$legacy" ] || [ -L "$legacy" ]; then
      if [ ! -L "$legacy" ] || ! [ "$legacy" -ef "$canonical" ]; then
        rm -f "$legacy" || err "could not replace legacy ARC binary: $legacy"
        ln -s "$canonical" "$legacy" || err "could not forward legacy ARC path: $legacy"
      fi
    fi
  done

  # Repoint recognized ARC links in every current PATH directory. Unrelated
  # executables named arc are never overwritten.
  old_ifs=$IFS
  IFS=:
  for dir in $PATH; do
    [ -n "$dir" ] || continue
    for command in arc agent-run-cache; do
      repoint_link "$dir/$command" "$canonical"
    done
  done
  IFS=$old_ifs

  # Keep one stable user-level forwarder across Node version-manager prefixes.
  user_bin="$HOME/.local/bin"
  mkdir -p "$user_bin"
  for command in arc agent-run-cache; do
    path="$user_bin/$command"
    if [ ! -e "$path" ] && [ ! -L "$path" ]; then
      ln -s "$canonical" "$path" || err "could not create ARC command link: $path"
    elif [ -L "$path" ]; then
      target=$(readlink "$path" 2>/dev/null || true)
      if is_arc_target "$target" || [ "$path" -ef "$canonical" ]; then
        rm -f "$path"
        ln -s "$canonical" "$path" || err "could not update ARC command link: $path"
      fi
    fi
  done
}

verify_install() {
  prefix=$1
  canonical="$prefix/bin/arc"
  [ -x "$canonical" ] || err "npm completed but did not install $canonical"
  "$canonical" metrics --json >/dev/null || err "the installed ARC binary failed its metrics smoke check"

  active=$(command -v arc 2>/dev/null || true)
  [ -n "$active" ] || err "ARC installed at $canonical but the npm global bin directory is not on PATH"
  if ! [ "$active" -ef "$canonical" ]; then
    err "another executable shadows ARC at $active; move it later in PATH and rerun this installer"
  fi
}

main() {
  require_runtime
  spec=$(package_spec)
  prefix=$(npm config get prefix)
  [ -n "$prefix" ] || err "npm did not report a global prefix"

  migrate_legacy_npm_package
  clear_stale_legacy_npm_links "$prefix"
  printf 'Installing %s...\n' "$spec"
  npm install -g "$spec" --include=optional || err "npm could not install $spec"

  canonical="$prefix/bin/arc"
  reconcile_legacy_paths "$canonical"
  hash -r 2>/dev/null || true
  verify_install "$prefix"

  printf '\nARC is ready. Desktop and Copilot share local cache data without sharing executables.\n'
  printf 'Next:\n  arc plugin install\n  arc split\n'
}

main "$@"
