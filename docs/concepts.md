# Concepts

This page explains the model behind agent-auth: who delegates, what a token carries, how scopes
match requests and how authority narrows as it passes from agent to sub-agent.

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
[`test/scope/properties.test.ts`](https://github.com/superintelligenceco/agent-auth/blob/main/test/scope/properties.test.ts) check that an accepted child set
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

Report vulnerabilities as described in [SECURITY.md](https://github.com/superintelligenceco/agent-auth/blob/main/SECURITY.md).
