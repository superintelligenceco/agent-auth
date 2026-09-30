# Security policy

agent-auth decides what AI agents may do on a person's behalf, so security reports get priority.

## Supported versions

| Version | Supported |
| --- | --- |
| 0.1.x | Yes |

## Report a vulnerability

Do not open a public issue. Report privately through
[GitHub security advisories](https://github.com/superintelligenceco/agent-auth/security/advisories/new).

Include:

- The affected version or commit.
- The scopes, requests or API calls that reproduce the problem.
- What an attacker gains, for example a token that permits a request its parent denies.

You get an acknowledgment within 3 business days and a status update at least every 7 days until
the issue is resolved. After a fix ships, the advisory is published with credit to you unless you
prefer to stay anonymous.

## In scope

- An attenuated token that permits a request its parent denies.
- A request allowed when no scope permits it, or a scope matching requests outside its grammar.
- Use of a revoked or expired token, or of a token whose ancestor is revoked or expired.
- Reuse of an approval, or an approval that covers a different request or token.
- Audit log changes that `audit verify` fails to detect, within the limits in the README.
- Forged tokens or signature bypass.
- Access to admin endpoints without the admin token.

## Out of scope

The limits listed under "Threat model" in the [README](README.md#threat-model), such as bearer
token theft, offline verifiers accepting revoked tokens before expiry, and an attacker who controls
the server or its signing key.
