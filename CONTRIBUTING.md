# Contributing to agent-auth

Thanks for helping. This guide covers how to set up the project, what a good change looks like, and
how to get it merged.

## Before you start

- For a bug, open an issue with the bug report form. For a security problem, follow
  [SECURITY.md](SECURITY.md) instead.
- For a new feature or any change to the scope grammar, open a feature request first so you can
  agree on the design before you write code.
- Follow the [code of conduct](CODE_OF_CONDUCT.md).

## Set up

You need Node.js 20 or later and npm.

```sh
git clone https://github.com/superintelligenceco/agent-auth && cd agent-auth
npm ci
npm test
```

`better-sqlite3` ships prebuilt binaries for common platforms. If npm has to compile it, install
Python 3 and a C++ toolchain.

## Project layout

| Path | Contents |
| --- | --- |
| `src/scope/` | Scope parser, matcher and attenuation check. No I/O. |
| `src/service.ts` | Grants, tokens, checks, revocation, approvals and audit, on SQLite |
| `src/server.ts` | REST API (Hono) over the service |
| `src/middleware.ts` | `verify()`, `verifyNode()` and the online and offline verifiers |
| `src/client.ts` | Typed HTTP client |
| `src/cli.ts` | The `agent-auth` command |
| `test/` | Unit, property-based, integration and CLI tests |
| `examples/` | Credential proxy and MCP server, each with a test |
| `openapi.yaml` | API description, checked against the server's routes |

## Make a change

1. Create a branch from `main`.
2. Write a test that fails without your change.
3. Make the change and keep it focused. Separate refactors from behavior changes.
4. Run the same checks as CI:

   ```sh
   npm run lint
   npm run format:check   # npm run format fixes formatting
   npm run typecheck
   npm run test:coverage
   ```

5. Update `openapi.yaml`, the README and the `Unreleased` section of `CHANGELOG.md` when you change
   the API, the CLI or the scope grammar.

### Changes to the scope matcher

`src/scope/` decides what every token may do, so changes there need extra care:

- Keep `scopeSubset` sound: if it returns `true`, the child must never match a request that the
  parent rejects. When in doubt, return `false`; rejecting a valid attenuation is safe, accepting an
  invalid one is a vulnerability.
- Add a property-based test in `test/scope/properties.test.ts` for any new constraint type.
- Check that the properties catch a deliberately broken implementation before you trust them.

## Commit messages and pull requests

Use [Conventional Commits](https://www.conventionalcommits.org/), for example
`feat(scope): support numeric ranges` or `fix(cli): exit 3 on deny`. Release notes and version
numbers are generated from these messages.

Open a pull request against `main` and fill in the template. A maintainer listed in
`.github/CODEOWNERS` reviews it. CI must pass before merge.

## License

By contributing, you agree that your contributions are licensed under the
[Apache License 2.0](LICENSE).
