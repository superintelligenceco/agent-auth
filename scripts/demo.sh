#!/usr/bin/env bash
# Runs the demo session shown in docs/public/demo.gif against a fresh server.
# Record it with: asciinema rec -c scripts/demo.sh demo.cast && agg demo.cast docs/public/demo.gif
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
WORK=$(mktemp -d)
trap 'kill "$SERVER" 2>/dev/null || true; rm -rf "$WORK"' EXIT
cd "$WORK"

agent-auth() { node "$ROOT/dist/cli.js" "$@"; }
export AGENT_AUTH_ADMIN_TOKEN=demo-admin-token-0123456789
node "$ROOT/dist/cli.js" serve --db "$WORK/db.sqlite" --key "$WORK/key.pem" >/dev/null 2>&1 &
SERVER=$!
until curl -fsS http://127.0.0.1:8787/healthz >/dev/null 2>&1; do sleep 0.1; done

# Prints a command as if typed, then runs it.
run() {
  printf '\033[1;32m$\033[0m '
  local i
  for ((i = 0; i < ${#1}; i++)); do printf '%s' "${1:i:1}"; sleep 0.02; done
  printf '\n'
  eval "$1" || true
  sleep 1.2
}

run "TOKEN=\$(agent-auth grant --principal alice --agent assistant --scope 'gmail:send to:*@acme.com' --scope 'payments:charge max=50USD' --ttl 1h -q)"
run "agent-auth check --token \"\$TOKEN\" --action gmail:send --param to=bob@acme.com"
run "agent-auth check --token \"\$TOKEN\" --action gmail:send --param to=eve@evil.example"
run "agent-auth check --token \"\$TOKEN\" --action payments:charge --amount 80USD"
run "SUB=\$(agent-auth attenuate --token \"\$TOKEN\" --agent reviewer --scope 'gmail:send to:bob@acme.com' --ttl 10m -q)"
run "agent-auth attenuate --token \"\$SUB\" --scope 'gmail:send to:*'"
run "agent-auth revoke --token \"\$TOKEN\""
run "agent-auth check --token \"\$SUB\" --action gmail:send --param to=bob@acme.com"
run "agent-auth audit verify"
sleep 2
