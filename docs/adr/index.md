# Architecture decision records

Each record describes a decision that shapes agent-auth, the context it was made in and what it
costs. Records are immutable once accepted. A later record can supersede an earlier one.

| Record | Status |
| --- | --- |
| [1. Ed25519 JWTs backed by server state](./0001-signed-tokens-with-server-state) | Accepted |
| [2. Hash-chained audit log in SQLite](./0002-hash-chained-audit-log) | Accepted |
| [3. Conservative scope attenuation](./0003-conservative-attenuation) | Accepted |
| [4. Bun executables and tag-driven releases](./0004-bun-executables-and-tag-releases) | Accepted |

To propose a new decision, copy the structure of an existing record into a pull request.
