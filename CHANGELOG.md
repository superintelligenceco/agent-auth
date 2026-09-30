# Changelog

All notable changes to this project are documented in this file. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [0.2.0](https://github.com/superintelligenceco/agent-auth/compare/agent-auth-v0.1.0...agent-auth-v0.2.0) (2026-09-30)


### Features

* **audit:** add hash-chained, append-only audit log ([b2f118a](https://github.com/superintelligenceco/agent-auth/commit/b2f118a4e7bb8880c1a6389b7e69e116049bcbee))
* **cli:** add agent-auth command ([4308341](https://github.com/superintelligenceco/agent-auth/commit/4308341ee52367a3a3269712964756e8c1f37d80))
* **examples:** add credential proxy and MCP server examples ([909090a](https://github.com/superintelligenceco/agent-auth/commit/909090a0ecf18d2c5968303c398cefe4b49e07f0))
* **middleware:** add verify() middleware for tool servers ([13cd773](https://github.com/superintelligenceco/agent-auth/commit/13cd7737bc168e5d6fde080fdffff7ff7250d79c))
* **scope:** add scope grammar, matcher and attenuation check ([13a3695](https://github.com/superintelligenceco/agent-auth/commit/13a36951bb4164faa40d57626047277f287f75ae))
* **server:** add REST API, HTTP client and OpenAPI spec ([1e4d3b6](https://github.com/superintelligenceco/agent-auth/commit/1e4d3b6d7020d49eabad955f6265c6cd4de72818))
* **service:** add grants, attenuation, revocation and approvals ([51fb171](https://github.com/superintelligenceco/agent-auth/commit/51fb1713f9efca431e56034fd3761ae3f050377e))
* **tokens:** sign agent tokens with Ed25519 ([4317d5c](https://github.com/superintelligenceco/agent-auth/commit/4317d5ca34754f7a2728134f5debe2b38699c7dd))

## [Unreleased]

## [0.1.0] - 2026-09-30

The first release: a self-hosted service, SDK and CLI for scoped, expiring, auditable agent
credentials.

### Added

- Scope grammar with action patterns, resource and parameter globs, per-request amount limits and
  `approval=required`, plus a canonical text form.
- Scope matcher that returns `allow`, `deny` or `approval_required`, and names the closest scope
  and the failed constraint on denial.
- Attenuation check that accepts a child scope set only when a single parent scope covers each child
  scope, with property-based tests that an accepted child never permits what its parent denies.
- Ed25519-signed JWT agent tokens with principal, grant, parent, depth and use-limit claims, and a
  JWKS endpoint for offline verification.
- Grants with TTLs and use limits; attenuated tokens capped at the parent's expiry, use limit and a
  maximum delegation depth; use limits enforced across the whole chain.
- Revocation of a token with all of its descendants, and of a whole grant.
- Human approval flow: pending approvals bound to one token and one exact request, consumed on
  first use.
- Hash-chained, append-only audit log of every grant, attenuation, revocation, check and approval,
  with verification from the API or directly from the database file and head anchoring to detect
  truncation.
- REST API on Hono with SQLite storage, described in `openapi.yaml`.
- `verify()` middleware for Hono, `verifyNode()` for Connect-style servers, and online and offline
  verifiers.
- Typed HTTP client.
- `agent-auth` CLI: `serve`, `grant`, `attenuate`, `check`, `inspect`, `revoke`, `approvals`,
  `approve`, `deny`, `audit log` and `audit verify`.
- Credential proxy example that injects an upstream API key only for permitted requests.
- MCP server example with guarded tools.
- Dockerfile and Docker Compose file.

[Unreleased]: https://github.com/superintelligenceco/agent-auth/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/superintelligenceco/agent-auth/releases/tag/v0.1.0
