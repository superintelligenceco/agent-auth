# 2. Hash-chained audit log in SQLite

Status: accepted

## Context

The audit log is how a principal learns what an agent did under their authority. Anyone with
write access to the database could alter it, and a plain table gives no way to notice.

## Decision

Every grant, attenuation, denied attenuation, revocation, check and approval decision appends a
row to the `audit` table in the same transaction as the change it records. Each row stores
`hash = sha256(prevHash + "\n" + canonicalJson({seq, ts, type, actor, data}))`. SQLite triggers
reject `UPDATE` and `DELETE` on the table. `agent-auth audit verify` recomputes the chain from the
API or straight from a database file and reports the first entry that fails. `--head` checks that a
previously anchored head hash is still in the chain.

## Consequences

- Edits and deletions in the middle of the log are detected without any extra infrastructure.
- The log is tamper-evident, not tamper-proof. Detecting a rewrite of the whole chain or removed
  trailing entries needs a head hash stored outside the service.
- Entries are hashed, not signed. Signed checkpoints are on the roadmap.
- Canonical JSON keeps the hash stable across runtimes and key orders.
