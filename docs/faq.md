# FAQ

## How is this different from OAuth scopes?

OAuth scopes are coarse and fixed by the provider. `gmail.send` lets the holder email anyone.
agent-auth scopes constrain parameters, resources and amounts, such as
`gmail:send to:*@acme.com`, and an agent can narrow them further for a sub-agent. agent-auth does
not replace the upstream credential. It decides whether a specific request may use it. The
[credential proxy example](/tool-servers#credential-proxy) keeps the upstream key away from the
agent entirely.

## Does the agent ever see my real API key?

Not if you use the credential proxy pattern. The agent holds only its agent-auth token. The proxy
checks each request and adds the real key to the requests that agent-auth allows.

## Can I verify tokens without calling the server?

Yes. `offlineVerifier()` checks the signature, expiry and scopes with the public key from
`/.well-known/jwks.json`. It cannot see revocations, use counts or approvals, so it denies scopes
that need approval and accepts a revoked token until it expires. Use short TTLs with it.

## What happens if someone edits the database?

SQLite triggers reject `UPDATE` and `DELETE` on the audit table, but anyone who can write the file
can drop them. `agent-auth audit verify` then reports the first entry whose hash no longer matches.
To also detect a rewrite of the whole log or removed trailing entries, store the `head` hash
somewhere the service cannot write and pass it back with `--head`.

## Does a sub-agent's use count against the parent?

Yes. A use of a child token counts against every token above it, so a sub-agent cannot multiply
the uses its parent was granted.

## Can I run more than one server?

Not yet. Storage is one SQLite file, so run a single instance. PostgreSQL storage is on the
roadmap.

## Is there TLS?

No. The server binds to loopback by default. Put a TLS-terminating proxy in front of it before you
expose it on a network.

## How do I rotate the signing key?

Key rotation is on the roadmap. Today, replacing the key file invalidates every outstanding token.

## Which platforms do the executables support?

Linux x64 and arm64, macOS on Intel and Apple silicon, and Windows x64. The container image
supports `linux/amd64` and `linux/arm64`. The npm package runs on Node.js 20 or later.

## How do I check that a download is genuine?

Each release asset has a build provenance attestation, and the image is signed with cosign:

```sh
gh attestation verify agent-auth-linux-x64 -R superintelligenceco/agent-auth
cosign verify ghcr.io/superintelligenceco/agent-auth:latest \
  --certificate-identity-regexp '^https://github.com/superintelligenceco/agent-auth/' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```
