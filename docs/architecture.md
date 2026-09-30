# Architecture

agent-auth is one process with one SQLite file. The same package provides the server, the CLI,
the SDK client and the tool-server middleware.

## Components

```mermaid
flowchart LR
  subgraph Callers
    P["Principal<br/>(CLI or SDK, admin token)"]
    A["Agent<br/>(agent token)"]
  end
  subgraph TS["Tool server"]
    MW["verify() middleware<br/>src/middleware.ts"]
  end
  subgraph S["agent-auth server"]
    API["REST API (Hono)<br/>src/server.ts"]
    SVC["Service<br/>src/service.ts"]
    SC["Scope engine, no I/O<br/>src/scope/"]
    TK["Token signing, Ed25519 JWT<br/>src/tokens.ts, src/keys.ts"]
    AU["Audit hash chain<br/>src/audit.ts"]
    DB[("SQLite<br/>grants, tokens, approvals, audit")]
  end
  UP["Upstream API"]

  P -- "grant, revoke, approve, audit" --> API
  A -- "attenuate, introspect" --> API
  A -- "request + token" --> MW
  MW -- "POST /v1/check" --> API
  MW -. "offline: JWKS" .-> API
  MW -- "allowed requests only" --> UP
  API --> SVC
  SVC --> SC
  SVC --> TK
  SVC --> AU
  SVC --> DB
  AU --> DB
```

| Module | Responsibility |
| --- | --- |
| `src/scope/` | Parses scopes, matches requests and checks that a child scope set is covered by its parent. Pure functions, no I/O. |
| `src/service.ts` | Grants, tokens, checks, use counts, revocation, approvals and audit entries, in SQLite transactions. |
| `src/server.ts` | The REST API described by `openapi.yaml`. |
| `src/tokens.ts`, `src/keys.ts` | Signs and verifies tokens with an Ed25519 key that the server creates on first start. |
| `src/audit.ts` | Hashes each audit entry over the previous hash and verifies the chain. |
| `src/db.ts` | Opens SQLite with `better-sqlite3` on Node.js or `bun:sqlite` in the standalone executables, and installs the append-only triggers. |
| `src/middleware.ts` | `verify()` for Hono, `verifyNode()` for Connect-style servers, and the online and offline verifiers. |
| `src/client.ts`, `src/cli.ts` | The typed HTTP client and the `agent-auth` command built on it. |

## What happens on a check

```mermaid
sequenceDiagram
  participant Agent
  participant Tool as Tool server
  participant AA as agent-auth
  participant DB as SQLite
  Agent->>Tool: request + agent token
  Tool->>AA: POST /v1/check {token, action, resource, params, amount}
  AA->>AA: verify signature and expiry
  AA->>DB: load token chain to the root
  AA->>AA: reject if any token in the chain is revoked or expired
  AA->>AA: evaluate scopes against the request
  AA->>DB: in one transaction, enforce use limits, count the use on every token in the chain, append the audit entry
  AA-->>Tool: allow, deny with reason, or approval_required
  Tool-->>Agent: forward to upstream, or 403
```

A check writes its audit entry in the same transaction as the use count, so a decision is never
returned without a record of it.

## Design decisions

The [architecture decision records](/adr/) explain why the service works this way.
