#!/bin/sh
# Installs the agent-auth standalone executable from a GitHub Release.
#
#   curl -fsSL https://raw.githubusercontent.com/superintelligenceco/agent-auth/main/install.sh | sh
#
# Environment variables:
#   AGENT_AUTH_VERSION      release tag to install, for example v0.2.0 (default: latest)
#   AGENT_AUTH_INSTALL_DIR  target directory (default: /usr/local/bin if writable, else ~/.local/bin)
set -eu

REPO="superintelligenceco/agent-auth"
VERSION="${AGENT_AUTH_VERSION:-latest}"

say() { printf 'agent-auth: %s\n' "$*" >&2; }
fail() { say "error: $*"; exit 1; }

need() { command -v "$1" >/dev/null 2>&1 || fail "$1 is required"; }

download() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --retry 3 -o "$2" "$1"
  elif command -v wget >/dev/null 2>&1; then
    wget -q -O "$2" "$1"
  else
    fail "curl or wget is required"
  fi
}

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | cut -d' ' -f1
  else
    fail "sha256sum or shasum is required"
  fi
}

os=$(uname -s)
arch=$(uname -m)
case "$os" in
  Linux) os=linux ;;
  Darwin) os=macos ;;
  *) fail "unsupported OS $os; on Windows download agent-auth-windows-x64.exe from the release page" ;;
esac
case "$arch" in
  x86_64 | amd64) arch=x64 ;;
  aarch64 | arm64) arch=arm64 ;;
  *) fail "unsupported architecture $arch" ;;
esac
asset="agent-auth-$os-$arch"

if [ "$VERSION" = latest ]; then
  base="https://github.com/$REPO/releases/latest/download"
else
  base="https://github.com/$REPO/releases/download/$VERSION"
fi

if [ -n "${AGENT_AUTH_INSTALL_DIR:-}" ]; then
  dir="$AGENT_AUTH_INSTALL_DIR"
elif [ -w /usr/local/bin ]; then
  dir=/usr/local/bin
else
  dir="$HOME/.local/bin"
fi

need uname
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT INT TERM

say "downloading $asset ($VERSION)"
download "$base/$asset" "$tmp/$asset"
download "$base/SHA256SUMS" "$tmp/SHA256SUMS"

want=$(awk -v f="$asset" '$2 == f || $2 == "*" f { print $1 }' "$tmp/SHA256SUMS")
[ -n "$want" ] || fail "$asset is not listed in SHA256SUMS"
got=$(sha256 "$tmp/$asset")
[ "$want" = "$got" ] || fail "checksum mismatch for $asset"

mkdir -p "$dir"
chmod +x "$tmp/$asset"
mv "$tmp/$asset" "$dir/agent-auth"
say "installed $("$dir/agent-auth" --version) to $dir/agent-auth"
case ":$PATH:" in
  *":$dir:"*) ;;
  *) say "add $dir to your PATH" ;;
esac
