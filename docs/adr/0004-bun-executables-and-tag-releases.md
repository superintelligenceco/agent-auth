# 4. Bun executables and tag-driven releases

Status: accepted

## Context

Users who only want the CLI or the server should not need a Node.js install. The Node.js build
uses `better-sqlite3`, a native addon that a single-file executable cannot load. The project first
used release-please, which cut releases from merged pull requests, while the artifacts needed a
build on a tag.

## Decision

Standalone executables are compiled with `bun build --compile` for Linux x64 and arm64, macOS x64
and arm64, and Windows x64. On Bun, `openDatabase()` uses the built-in `bun:sqlite` driver, whose
API covers every call the package makes. A pushed `v*` tag runs one workflow that builds the
executables, the multi-arch image and the npm tarball, smoke-tests each on its platform, attaches
them to the GitHub Release with `SHA256SUMS`, an SPDX SBOM and provenance attestations, signs the
image with cosign and publishes the npm package. release-please was removed so that there is one
release path.

## Consequences

- One download runs the CLI and the server on each supported platform.
- Two SQLite drivers must stay compatible. The smoke test runs every executable against a real
  grant, check, revoke and audit sequence.
- Releases need a manual version bump and CHANGELOG entry before the tag.
