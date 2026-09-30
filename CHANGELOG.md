# Changelog

All notable changes to this project are documented in this file. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Multi-arch (`linux/amd64`, `linux/arm64`) server image on
  `ghcr.io/superintelligenceco/agent-auth`, tagged `:vX.Y.Z` and `:latest` on releases and `:edge`
  and `:sha-<commit>` on manual builds.
- Standalone `agent-auth` executables for Linux x64, Linux arm64, macOS arm64 and Windows x64, built
  with Bun, and the npm package tarball, attached to each GitHub Release with `SHA256SUMS`.
- `agent-auth --version`.
- `scripts/smoke.sh`, a grant, check, revoke and audit check against a running server.

### Changed

- `openDatabase()` uses Bun's built-in `bun:sqlite` driver when it runs on Bun.
- Releases come from pushed `v*` tags instead of release-please.

### Fixed

- The SDK client and `onlineVerifier()` trim trailing slashes from `baseUrl` in linear time.
- `loadOrCreateSigningKey()` no longer races with another process that creates the key file at the
  same time; the later process loads the key the first one wrote.

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
