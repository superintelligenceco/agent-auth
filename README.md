# agent-auth

Scoped, expiring, auditable credentials for AI agents that act on a user's behalf.

[![CI](https://github.com/superintelligenceco/agent-auth/actions/workflows/ci.yml/badge.svg)](https://github.com/superintelligenceco/agent-auth/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

agent-auth is a small self-hosted service and TypeScript SDK. A user (the principal) grants an agent a
short-lived token that carries explicit scopes such as `gmail:send to:*@acme.com` or
`payments:charge max=50USD`. Tool servers ask agent-auth whether a token permits a concrete request.
An agent can derive a narrower token for a sub-agent, but never a broader one. You can revoke any
token together with everything derived from it, and every decision lands in a hash-chained audit log
that detects tampering.

## Install

Each release ships a server image, standalone executables and the npm package.

### Container image

The image runs the server on port 8787 and keeps its database and signing key in `/data`. It
supports `linux/amd64` and `linux/arm64`.

```sh
export AGENT_AUTH_ADMIN_TOKEN=$(openssl rand -hex 24)
docker run -d --name agent-auth -p 127.0.0.1:8787:8787 \
  -e AGENT_AUTH_ADMIN_TOKEN -v agent-auth-data:/data \
  ghcr.io/superintelligenceco/agent-auth:latest
```

Tags: `:latest` and `:vX.Y.Z` for releases, `:edge` for the latest build from `main`, and
`:sha-<commit>` for a specific build.

### Standalone executable

The `agent-auth` executable contains the CLI and the server and needs no Node.js install. Pick the
asset for your platform:

| Platform | Asset |
| --- | --- |
| Linux x64 | `agent-auth-linux-x64` |
| Linux arm64 | `agent-auth-linux-arm64` |
| macOS Apple silicon | `agent-auth-macos-arm64` |
| Windows x64 | `agent-auth-windows-x64.exe` |

```sh
base=https://github.com/superintelligenceco/agent-auth/releases/latest/download
curl -fsSLO "$base/agent-auth-linux-x64" -fsSLO "$base/SHA256SUMS"
sha256sum --check --ignore-missing SHA256SUMS
chmod +x agent-auth-linux-x64 && sudo mv agent-auth-linux-x64 /usr/local/bin/agent-auth
agent-auth --version
```

### npm package

The SDK and CLI ship as an npm tarball, `agent-auth-<version>.tgz`, on each release:

```sh
gh release download -R superintelligenceco/agent-auth -p 'agent-auth-*.tgz'
npm install ./agent-auth-*.tgz
```

The package needs Node.js 20 or later.

## Quickstart

To build from source, you need Node.js 20 or later. To use a release instead, see [Install](#install).

```sh
git clone https://github.com/superintelligenceco/agent-auth && cd agent-auth
npm ci && npm run build && alias agent-auth="node $PWD/dist/cli.js"
export AGENT_AUTH_ADMIN_TOKEN=$(openssl rand -hex 24) && agent-auth serve &
```

The server listens on `http://127.0.0.1:8787` and stores its database and signing key in `./data`.
To run it in Docker instead, set `AGENT_AUTH_ADMIN_TOKEN` and run `docker compose up -d`.

## See it work

This is an unedited session against the server started above. Exit codes: `0` allow, `3` deny,
`4` approval required.

```console
$ TOKEN=$(agent-auth grant --principal alice --agent assistant \
    --scope 'gmail:send to:*@acme.com' \
    --scope 'github:repo:read acme/*' \
    --scope 'payments:charge max=50USD' \
    --ttl 1h --max-uses 20 -q)
$ agent-auth inspect --token "$TOKEN"
token     tk_QgWW0aC8lDq-ZISd  (root)
principal alice
agent     assistant
grant     gr_YRMm_XBHvR7nHePj
expires   2026-09-30T11:00:39.000Z
scope     gmail:send to:*@acme.com
scope     github:repo:read acme/*
scope     payments:charge max=50USD
max uses  20
status    active, 0 use(s), chain depth 0
$ agent-auth check --token "$TOKEN" --action gmail:send --param to=bob@acme.com
ALLOW             [gmail:send to:*@acme.com] (19 uses left)
$ agent-auth check --token "$TOKEN" --action gmail:send --param to=eve@evil.example
DENY              to eve@evil.example does not match *@acme.com (scope: gmail:send to:*@acme.com)
$ agent-auth check --token "$TOKEN" --action payments:charge --amount 80USD
DENY              amount exceeds max=50USD (scope: payments:charge max=50USD)
$ SUB=$(agent-auth attenuate --token "$TOKEN" --agent reviewer \
    --scope 'github:repo:read acme/widgets' --ttl 10m -q)
$ agent-auth attenuate --token "$SUB" --scope 'github:repo:read acme/*'
error: scope_escalation: requested scopes exceed the parent token
  not covered by parent: github:repo:read acme/*
$ agent-auth check --token "$SUB" --action github:repo:read --resource acme/widgets
ALLOW             [github:repo:read acme/widgets] (18 uses left)
$ agent-auth revoke --token "$TOKEN"
revoked 2 token(s): tk_QgWW0aC8lDq-ZISd, tk_-S5mBB3c_XIhL25B
$ agent-auth check --token "$SUB" --action github:repo:read --resource acme/widgets
DENY              revoked
$ agent-auth audit log
   1  10:00:39  grant.created            admin              gr_YRMm_XBHvR7nHePj -> assistant for alice
   2  10:00:39  check                    agent:assistant    allow             gmail:send  tk_QgWW0aC8lDq-ZISd
   3  10:00:40  check                    agent:assistant    deny              gmail:send  tk_QgWW0aC8lDq-ZISd
   4  10:00:40  check                    agent:assistant    deny              payments:charge  tk_QgWW0aC8lDq-ZISd
   5  10:00:40  token.attenuated         agent:assistant    tk_QgWW0aC8lDq-ZISd -> tk_-S5mBB3c_XIhL25B (reviewer)
   6  10:00:40  token.attenuation_denied agent:reviewer     tk_-S5mBB3c_XIhL25B tried github:repo:read acme/*
   7  10:00:41  check                    agent:reviewer     allow             github:repo:read acme/widgets  tk_-S5mBB3c_XIhL25B
   8  10:00:41  token.revoked            agent:assistant    tk_QgWW0aC8lDq-ZISd, 2 token(s) revoked
   9  10:00:41  check                    system             deny              github:repo:read acme/widgets  (revoked)
$ agent-auth audit verify
OK        9 entries, chain intact
head      373c38c4526d7b9fb41ceeee8a2de32e2aa9769e23b4d8029bdbbda7ebb71614
```

The sub-agent's use counted against the root token too, so the root reports 18 uses left. Then
someone with write access to the database file bypasses the append-only trigger and flips entry 4
from `deny` to `allow`:

```console
$ sqlite3 data/agent-auth.db "DROP TRIGGER audit_no_update;
    UPDATE audit SET data = replace(data, '\"deny\"', '\"allow\"') WHERE seq = 4;"
$ agent-auth audit verify --db data/agent-auth.db
TAMPERED  entry 4 hash mismatch (content altered)
first bad entry: seq 4
verified  3 entries before the break
```

## Why it exists

Agents that send email, open pull requests or spend money usually hold the same credential a human
would: a long-lived API key or an OAuth token with coarse scopes. `gmail.send` lets an agent email
anyone. A GitHub token with `repo` reaches every repository. When one agent hands work to another,
the sub-agent gets the whole key. Nothing records which agent did what under whose authority.

agent-auth puts a narrow, short-lived, revocable token between the agent and the real credential:

- Scopes describe the specific actions, resources, parameters and spend limits you allow.
- Tokens expire in minutes or hours and can carry a use limit.
- Sub-agents get attenuated tokens that the service proves are no broader than their parent.
- Risky scopes can require a human to approve each use.
- Revoking a token cuts off everything derived from it.
- Every check lands in a tamper-evident log.

The [credential proxy example](#credential-proxy) takes this one step further: the agent never sees
the upstream API key at all.

## Concepts

### Principal, agent and grant

A **principal** is the person or account that delegates authority, such as `alice`. An **agent** is
the software that acts for them, such as `assistant`. A **grant** records that a principal gave an
agent a set of scopes until a point in time, optionally with a maximum number of uses. Creating a
grant returns the grant's root token. Only the holder of the admin token creates grants.

### Tokens

Tokens are compact JWS (JWT) values signed with Ed25519 (`alg: EdDSA`, `typ: agent-auth+jwt`).
The service publishes its public key at `/.well-known/jwks.json`.

| Claim | Meaning |
| --- | --- |
| `iss` | Issuer URL of the agent-auth service |
| `sub` | Agent the token belongs to |
| `prn` | Principal that delegated authority |
| `gnt` | Grant the token descends from |
| `scp` | Scopes in canonical form |
| `jti` | Token id |
| `par` | Parent token id, for attenuated tokens |
| `dep` | Delegation depth; the grant's root token has depth 0 |
| `mxu` | Maximum uses, when limited |
| `iat`, `exp` | Issue and expiry times |

### Scope grammar

```text
<action> [<resource-glob>] [<key>:<glob> ...] [max=<amount>[<CUR>]] [approval=required]
```

| Scope | Permits |
| --- | --- |
| `gmail:send to:*@acme.com` | Sending mail when every `to` recipient ends in `@acme.com` |
| `github:repo:read acme/*` | Reading any repository in the `acme` organization |
| `github:* acme/widgets` | Any GitHub action on `acme/widgets` |
| `payments:charge max=50USD` | Charges up to 50 USD per request |
| `payments:refund max=500USD approval=required` | Refunds up to 500 USD, each approved by a human |
| `fs:read resource:reports:2026` | Reading the resource `reports:2026` (use `resource:` when the resource contains `:` or `=`) |

A request is concrete: an `action`, an optional `resource`, optional `params` (a string or a list of
strings per key) and an optional `amount`.

- **Actions** are lowercase segments separated by `:`. A `*` segment matches exactly one segment,
  except in the last position, where it matches one or more. `github:*` matches
  `github:repo:read`; `github:*:read` does not match `github:a:b:read`.
- **Resources and parameters** use globs in which `*` matches any run of characters, including
  `/`. Matching is case-sensitive. If a scope names a parameter, the request must include it, and
  every value in a list must match.
- **Amounts** must use the same currency as the limit and not exceed it. A request without an
  amount does not match a scope that has a limit.
- **Approval** turns an `allow` into `approval_required` until a human approves that exact request.

A request is allowed when any scope matches it without requiring approval. A denial names the
closest scope and the constraint that failed, so an agent can correct its request.

### Attenuation

Any token holder can derive a child token with `POST /v1/tokens/attenuate`. The service accepts the
child only when every child scope is covered by a single parent scope:

- The child's action pattern matches a subset of the parent's.
- The child's resource and parameter globs are subsets of the parent's. A child may add parameter
  constraints but never drop one.
- The child's amount limit uses the same currency and is no higher.
- If the parent scope requires approval, the child scope does too.

The child also expires no later than its parent, carries a use limit no higher than its parent's,
and sits one level deeper, up to a configurable maximum depth (8 by default). A use of a child token
counts against every token above it.

The glob subset check is conservative: it can reject a few exotic pairs where containment does
hold, and it never accepts a pair where it does not. Property-based tests in
[`test/scope/properties.test.ts`](test/scope/properties.test.ts) check that an accepted child set
never allows a request that its parent set denies, across chains of attenuations.

### Revocation

Revoking a token revokes all of its descendants. Revoking a grant revokes every token under it.
Each check also walks the token's chain back to the root, so a token whose ancestor is revoked or
expired is rejected even if it was issued before the revocation. An agent can revoke its own token
by presenting it; revoking an arbitrary token by id requires the admin token.

### Approvals

When a request matches only scopes marked `approval=required`, `check` returns `approval_required`
and an approval id. A human approves or denies it with the admin API or `agent-auth approve <id>`.
The agent then repeats the same request with the approval id. An approval covers exactly one
request (compared by a hash of its canonical JSON) on one token, and it is consumed on first use.

### Audit log

Every grant, attenuation, denied attenuation, revocation, check and approval decision appends an
entry to the `audit` table. Each entry stores
`hash = sha256(prevHash + "\n" + canonicalJson({seq, ts, type, actor, data}))`, and SQLite triggers
reject `UPDATE` and `DELETE` on the table. `agent-auth audit verify` recomputes the chain, either
from the API or directly from a database file, and reports the first entry that fails.

The chain alone cannot tell that entries were removed from the end, or that someone rewrote and
rehashed the whole log. To catch that, record the `head` hash somewhere the service cannot write,
and pass it back with `--head`: verification fails unless that hash is still in the chain.

## Use it from a tool server

A tool server maps each incoming request to an access request and asks agent-auth for a decision.
The `verify()` middleware does this for [Hono](https://hono.dev):

```ts
import { Hono } from "hono";
import { onlineVerifier, verify } from "agent-auth";

const app = new Hono();
const verifier = onlineVerifier({ baseUrl: "http://127.0.0.1:8787" });

app.post(
  "/repos/:owner/:repo/issues",
  verify({
    verifier,
    request: (c) => ({
      action: "github:issues:create",
      resource: `${c.req.param("owner")}/${c.req.param("repo")}`,
    }),
  }),
  (c) => c.json({ created: true }),
);
```

The middleware returns `401` without a token and `403` on denial. When a human must approve, it
returns `403` with `error.code: "approval_required"` and `error.approvalId`; the agent retries with
the `X-Agent-Auth-Approval` header. `verifyNode()` provides the same behavior for Express and other
Connect-style frameworks.

`offlineVerifier()` checks the signature, expiry and scopes locally with the public key, without a
network call. It cannot see revocations, use counts or approvals, so it denies approval scopes and
accepts a revoked token until it expires. Pair it with short TTLs.

### Credential proxy

[`examples/credential-proxy`](examples/credential-proxy) holds a real upstream API key and injects it
only into requests that the presented agent token permits. The agent sends its agent token, the
proxy checks it against a route table, strips the agent's credentials, adds the real key and
forwards the request. Routes that are not in the table return `404`, and denied requests never reach
the upstream API.

```sh
AGENT_AUTH_URL=http://127.0.0.1:8787 UPSTREAM_API_KEY=<your GitHub token> \
  npx tsx examples/credential-proxy/main.ts
```

### MCP server

[`examples/mcp-server`](examples/mcp-server) is a Model Context Protocol server whose `send_email`
and `charge_card` tools check the agent token before they act. A denied call returns a tool error
that states the reason. A call that needs approval returns the approval id, and the agent retries
with it once a human approves.

## SDK

agent-auth is not on the npm registry. Install the tarball from a release (see
[npm package](#npm-package)) or build it from source with `npm run build`.

```ts
import { AgentAuthClient } from "agent-auth";

const admin = new AgentAuthClient({
  baseUrl: "http://127.0.0.1:8787",
  adminToken: process.env.AGENT_AUTH_ADMIN_TOKEN,
});
const { token } = await admin.createGrant({
  principal: "alice",
  agent: "assistant",
  scopes: ["calendar:read", "calendar:write cal:work approval=required"],
  ttl: "2h",
});

const agent = new AgentAuthClient({ baseUrl: "http://127.0.0.1:8787" });
const res = await agent.check(token, { action: "calendar:read" });
// { decision: "allow", scope: "calendar:read", ... }
```

To embed the service in your own process instead of running the server, construct `AgentAuth`
with `openDatabase()` and `generateSigningKey()` or `loadOrCreateSigningKey()`. The scope matcher
is available on its own from `agent-auth/scope`.

## API

[`openapi.yaml`](openapi.yaml) describes every endpoint. A test keeps it in sync with the routes
the server exposes.

| Method and path | Auth | Purpose |
| --- | --- | --- |
| `POST /v1/grants` | admin | Create a grant and its root token |
| `GET /v1/grants` | admin | List grants, optionally by `principal` |
| `GET /v1/grants/{id}` | admin | Get a grant and all tokens under it |
| `POST /v1/grants/{id}/revoke` | admin | Revoke a grant and its tokens |
| `POST /v1/tokens/attenuate` | token | Derive a narrower token |
| `POST /v1/tokens/introspect` | token | Report whether a token is active, with its chain |
| `POST /v1/tokens/revoke` | token or admin | Revoke the presented token, or any token by `jti` |
| `POST /v1/check` | token | Decide `allow`, `deny` or `approval_required` |
| `GET /v1/approvals` | admin | List approvals by `status` |
| `POST /v1/approvals/{id}/approve` | admin | Approve a pending request |
| `POST /v1/approvals/{id}/deny` | admin | Deny a pending request |
| `GET /v1/audit` | admin | Read audit entries after a sequence number |
| `GET /v1/audit/verify` | admin | Verify the chain on the server |
| `GET /.well-known/jwks.json` | none | Public signing key |
| `GET /healthz` | none | Liveness |

Admin endpoints take `Authorization: Bearer <admin token>`. Agent endpoints take the agent token in
the JSON body.

## Configuration

| Variable | Flag | Default |
| --- | --- | --- |
| `AGENT_AUTH_ADMIN_TOKEN` | `--admin-token` | Required, 16 characters or more |
| `AGENT_AUTH_HOST` | `--host` | `127.0.0.1` |
| `AGENT_AUTH_PORT` | `--port` | `8787` |
| `AGENT_AUTH_DB` | `--db` | `./data/agent-auth.db` |
| `AGENT_AUTH_KEY` | `--key` | `./data/signing-key.pem`, created with mode `0600` on first start |
| `AGENT_AUTH_ISSUER` | `--issuer` | The URL the server listens on |
| `AGENT_AUTH_URL` | `--url` | `http://127.0.0.1:8787`, used by CLI commands |
| `AGENT_AUTH_TOKEN` | `--token` | Agent token for CLI commands; also accepts `@file` or `-` for stdin |

Run `agent-auth --help` for every command and option.

## Threat model

agent-auth limits what a compromised or misbehaving agent can do with delegated authority, and
records what it did. It assumes the agent-auth server, its database and its signing key are
trusted.

It helps against:

- An agent, or a prompt injection steering it, attempting actions outside its scopes.
- A sub-agent receiving more authority than the task needs, or widening its own token.
- A leaked agent token being useful for long: tokens expire, can carry use limits, and you can
  revoke them with their descendants.
- Silent edits to the audit history by someone with database access, provided you verify the
  chain and anchor the head outside the service.

Know its limits:

- **Tokens are bearer tokens.** Anyone who holds one can use it until it expires or you revoke it.
  There is no proof of possession yet.
- **The admin token is all-powerful.** Anyone with it can create grants and approve requests.
  Keep it out of agents' reach.
- **Enforcement happens where you call `check`.** A tool server that maps requests to the wrong
  action or resource, or skips the check, bypasses agent-auth. The credential proxy pattern keeps
  the real secret away from the agent so that skipping the check is not an option for it.
- **Offline verification does not see revocations** until the token expires.
- **The audit log is tamper-evident, not tamper-proof.** Someone who can write to the database can
  delete or rewrite entries; verification detects this, and detecting a rewrite of the latest
  entries requires an anchored head. Entries are hashed, not signed.
- **Use limits count allowed checks**, not successful upstream calls.
- **One signing key, no rotation yet.** Replacing the key file invalidates all outstanding tokens.
- **No TLS.** The server binds to loopback by default; put a TLS-terminating proxy in front before
  you expose it.
- **Single node.** Storage is one SQLite file.
- **Audit entries contain request details**, such as recipients and amounts. Treat the database as
  sensitive.

Report vulnerabilities as described in [SECURITY.md](SECURITY.md).

## Roadmap

- Signing key rotation with multiple keys in the JWKS
- Proof-of-possession tokens (DPoP)
- Signed audit checkpoints and scheduled head export
- Time-window rate limits and cumulative spend budgets per grant
- Approval notifications through webhooks
- PostgreSQL storage
- Published npm package and container image
- A Python client

## Development

```sh
npm ci
npm run lint && npm run format:check && npm run typecheck
npm test              # unit, property-based and integration tests
npm run test:coverage
```

Integration tests start real servers on random ports and generate keys at runtime.

To build the standalone executables, install [Bun](https://bun.sh) and run:

```sh
scripts/build-binaries.sh "$(node -p 'require("./package.json").version')" out
AGENT_AUTH_ADMIN_TOKEN=local-admin-token-0123 out/agent-auth-linux-x64 serve &
AGENT_AUTH_ADMIN_TOKEN=local-admin-token-0123 scripts/smoke.sh   # grant, check, revoke, audit
```

The executables run on Bun, so they use its built-in `bun:sqlite` driver instead of
`better-sqlite3`.

## Contributing

Contributions are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) and the
[code of conduct](CODE_OF_CONDUCT.md) first.

## License

[Apache-2.0](LICENSE)
