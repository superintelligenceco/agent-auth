# 1. Ed25519 JWTs backed by server state

Status: accepted

## Context

Agents need a credential they can pass to tool servers and to sub-agents. Two families fit:
stateless signed tokens, which anyone can verify with a public key, and opaque tokens, which only
the issuer can resolve. Agents also need revocation that takes effect at once, use limits and
human approvals, which all need shared state.

## Decision

Tokens are compact JWS values signed with Ed25519 (`alg: EdDSA`, `typ: agent-auth+jwt`). The claims
carry the agent, principal, grant, canonical scopes, parent token, delegation depth, use limit and
expiry. The server also stores every token row in SQLite. An online check verifies the signature,
then loads the token's chain back to the root and rejects it if any ancestor is revoked or expired.
The server publishes the public key at `/.well-known/jwks.json`.

## Consequences

- Tool servers choose their trade-off. `onlineVerifier()` sees revocations, use counts and
  approvals. `offlineVerifier()` needs no network call but accepts a revoked token until it
  expires and denies approval scopes.
- Ed25519 keys are small and fast, and signatures are deterministic.
- Tokens are bearer tokens: there is no proof of possession yet.
- There is one signing key. Rotation needs multiple keys in the JWKS, which is on the roadmap.
