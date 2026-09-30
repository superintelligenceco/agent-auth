#!/usr/bin/env bash
# Runs a grant -> check -> revoke flow against a running agent-auth server.
# Usage: AGENT_AUTH_ADMIN_TOKEN=... scripts/smoke.sh [base-url]
# Needs curl and jq. Exits non-zero on the first unexpected response.
set -euo pipefail

URL="${1:-http://127.0.0.1:8787}"
ADMIN="${AGENT_AUTH_ADMIN_TOKEN:?set AGENT_AUTH_ADMIN_TOKEN}"

for _ in $(seq 1 30); do
  curl -fsS "$URL/healthz" >/dev/null 2>&1 && break
  sleep 1
done
curl -fsS "$URL/healthz" >/dev/null

post() {
  curl -fsS -X POST "$URL$1" -H 'content-type: application/json' "${@:3}" -d "$2"
}

expect() {
  if [ "$2" != "$3" ]; then
    echo "FAIL $1: expected $3, got $2" >&2
    exit 1
  fi
  echo "ok   $1: $2"
}

grant=$(post /v1/grants \
  '{"principal":"alice","agent":"assistant","scopes":["gmail:send to:*@acme.com"],"ttl":"1h","maxUses":5}' \
  -H "authorization: Bearer $ADMIN")
token=$(jq -r .token <<<"$grant")
expect "grant" "$(jq -r '.grant.id | startswith("gr_")' <<<"$grant")" "true"

check() {
  post /v1/check "$(jq -nc --arg t "$token" --arg to "$1" \
    '{token:$t,request:{action:"gmail:send",params:{to:$to}}}')" | jq -r .decision
}

expect "check allowed recipient" "$(check bob@acme.com)" "allow"
expect "check other recipient" "$(check eve@evil.example)" "deny"
expect "introspect" "$(post /v1/tokens/introspect "$(jq -nc --arg t "$token" '{token:$t}')" | jq -r .active)" "true"
expect "revoke" "$(post /v1/tokens/revoke "$(jq -nc --arg t "$token" '{token:$t}')" | jq -r '.revoked | length')" "1"
expect "check after revoke" "$(check bob@acme.com)" "deny"
expect "introspect after revoke" "$(post /v1/tokens/introspect "$(jq -nc --arg t "$token" '{token:$t}')" | jq -r .active)" "false"
expect "audit chain" "$(curl -fsS "$URL/v1/audit/verify" -H "authorization: Bearer $ADMIN" | jq -r .ok)" "true"
echo "smoke test passed against $URL"
