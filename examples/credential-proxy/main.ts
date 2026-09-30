/**
 * Runs the credential proxy in front of the GitHub REST API.
 *
 *   AGENT_AUTH_URL=http://127.0.0.1:8787 \
 *   UPSTREAM_API_KEY=<your GitHub token> \
 *   npx tsx examples/credential-proxy/main.ts
 *
 * Agents then call http://127.0.0.1:8788/repos/<owner>/<repo>/issues with
 * `Authorization: Bearer <agent token>`.
 */
import { serve } from "@hono/node-server";
import { onlineVerifier } from "../../src/index.js";
import { createCredentialProxy, githubRules } from "./proxy.js";

const key = process.env.UPSTREAM_API_KEY;
if (!key) {
  console.error("set UPSTREAM_API_KEY");
  process.exit(1);
}

const app = createCredentialProxy({
  verifier: onlineVerifier({ baseUrl: process.env.AGENT_AUTH_URL ?? "http://127.0.0.1:8787" }),
  upstream: process.env.UPSTREAM_URL ?? "https://api.github.com",
  inject: { header: "authorization", value: `Bearer ${key}` },
  rules: githubRules,
});

const port = Number(process.env.PORT ?? 8788);
serve({ fetch: app.fetch, port, hostname: "127.0.0.1" }, () => {
  console.log(`credential proxy listening on http://127.0.0.1:${port}`);
});
