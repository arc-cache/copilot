#!/bin/sh
# ARC for GitHub Copilot CLI installer (macOS + Linux).
#
#   curl -fsSL https://raw.githubusercontent.com/arc-cache/copilot/main/install.sh | sh
#
# Env overrides:
#   ARC_VERSION       install a specific version (default: latest release)
#   ARC_INSTALL_DIR   install location (default: $HOME/.arc-copilot)
set -eu

REPO="arc-cache/copilot"
INSTALL_DIR="${ARC_INSTALL_DIR:-$HOME/.arc-copilot}"
BIN_DIR="$INSTALL_DIR/bin"

err() { printf 'arc install: %s\n' "$1" >&2; exit 1; }

have() { command -v "$1" >/dev/null 2>&1; }

fetch() {
  # fetch <url> <dest>; or stdout if <dest> omitted
  if have curl; then
    if [ "$#" -eq 2 ]; then curl -fsSL "$1" -o "$2"; else curl -fsSL "$1"; fi
  elif have wget; then
    if [ "$#" -eq 2 ]; then wget -qO "$2" "$1"; else wget -qO - "$1"; fi
  else
    err "need curl or wget"
  fi
}

detect_target() {
  os=$(uname -s)
  arch=$(uname -m)
  case "$os" in
    Darwin) os=darwin ;;
    Linux) os=linux ;;
    *) err "unsupported OS: $os (use npm: npm i -g arc-copilot)" ;;
  esac
  case "$arch" in
    x86_64 | amd64) arch=x64 ;;
    arm64 | aarch64) arch=arm64 ;;
    *) err "unsupported architecture: $arch" ;;
  esac
  printf '%s-%s' "$os" "$arch"
}

resolve_version() {
  if [ -n "${ARC_VERSION:-}" ]; then
    printf '%s' "${ARC_VERSION#v}"
    return
  fi
  tag=$(fetch "https://api.github.com/repos/$REPO/releases/latest" \
    | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -n1)
  [ -n "$tag" ] || err "could not determine the latest release (set ARC_VERSION)"
  printf '%s' "${tag#v}"
}

main() {
  target=$(detect_target)
  version=$(resolve_version)
  asset="arc-${version}-${target}.tar.gz"
  url="https://github.com/$REPO/releases/download/v${version}/${asset}"

  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' EXIT

  printf 'Downloading arc %s (%s)...\n' "$version" "$target"
  fetch "$url" "$tmp/$asset" || err "download failed: $url"

  mkdir -p "$BIN_DIR"
  tar -xzf "$tmp/$asset" -C "$BIN_DIR" || err "extract failed"
  chmod +x "$BIN_DIR/arc" 2>/dev/null || true
  [ -f "$BIN_DIR/zellij" ] && chmod +x "$BIN_DIR/zellij" 2>/dev/null || true

  printf 'Installed arc to %s\n' "$BIN_DIR/arc"

  # Put arc on PATH where we can, otherwise print instructions.
  linked=""
  for d in "$HOME/.local/bin" /usr/local/bin; do
    if [ -d "$d" ] && [ -w "$d" ]; then
      ln -sf "$BIN_DIR/arc" "$d/arc" && linked="$d/arc" && break
    fi
  done

  case ":$PATH:" in
    *":$BIN_DIR:"*) : ;;
    *)
      if [ -z "$linked" ]; then
        printf '\nAdd arc to your PATH:\n  export PATH="%s:$PATH"\n' "$BIN_DIR"
      fi
      ;;
  esac

  printf '\nNext:\n  arc setup\n  arc split\n'
}

main "$@"
