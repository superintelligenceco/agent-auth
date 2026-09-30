# AGENTS.md

Instructions for automated coding tools working in this repository. Human contributors can read
[CONTRIBUTING.md](CONTRIBUTING.md) instead; the rules are the same.

## Commands

```sh
npm ci                 # install
npm run lint           # Biome lint
npm run format:check   # Biome format check; npm run format writes fixes
npm run typecheck      # tsc --noEmit over src, test and examples
npm test               # Vitest: unit, property-based, integration and CLI tests
npm run build          # compile src to dist
```

Run all of the checks above before you report a change as done. They must pass.

## Rules

- TypeScript, ESM, Node.js 20 or later. Imports inside `src` use the `.js` extension.
- Keep `src/scope/` free of I/O. It is the security core; see "Changes to the scope matcher" in
  CONTRIBUTING.md.
- Any change that could widen what a token permits needs a property-based test that fails on the
  broken behavior.
- Keep `openapi.yaml` in sync with `src/server.ts`. `test/openapi.test.ts` fails when routes and the
  spec diverge.
- Never commit secrets, generated keys, `data/`, `dist/`, `coverage/` or `node_modules/`. Tests
  generate keys at runtime.
- Write docs in second person, present tense and active voice, with sentence-case headings.
- Use Conventional Commits.
