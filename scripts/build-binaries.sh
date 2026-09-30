#!/usr/bin/env bash
# Compiles the agent-auth CLI and server into standalone executables with Bun.
# Usage: scripts/build-binaries.sh <version> [out-dir] [target...]
# Targets default to all release platforms. Needs bun and an installed node_modules.
set -euo pipefail

version="${1:?usage: scripts/build-binaries.sh <version> [out-dir] [target...]}"
out="${2:-out}"
shift $(( $# > 1 ? 2 : 1 ))
targets=("$@")
if [ ${#targets[@]} -eq 0 ]; then
  targets=(linux-x64 linux-arm64 macos-x64 macos-arm64 windows-x64)
fi

mkdir -p "$out"
for t in "${targets[@]}"; do
  case "$t" in
    # The baseline x64 builds run on CPUs without AVX2.
    linux-x64) bun_target=bun-linux-x64-baseline; file=agent-auth-linux-x64 ;;
    linux-arm64) bun_target=bun-linux-arm64; file=agent-auth-linux-arm64 ;;
    macos-x64) bun_target=bun-darwin-x64; file=agent-auth-macos-x64 ;;
    macos-arm64) bun_target=bun-darwin-arm64; file=agent-auth-macos-arm64 ;;
    windows-x64) bun_target=bun-windows-x64-baseline; file=agent-auth-windows-x64.exe ;;
    *) echo "unknown target: $t" >&2; exit 1 ;;
  esac
  # better-sqlite3 is a Node addon; on Bun, src/db.ts uses bun:sqlite instead.
  bun build src/cli.ts --compile --minify \
    --target="$bun_target" \
    --external better-sqlite3 \
    --define "AGENT_AUTH_VERSION=\"$version\"" \
    --outfile "$out/$file"
done
ls -l "$out"
