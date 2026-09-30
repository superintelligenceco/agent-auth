# Use it from a tool server

A tool server maps each incoming request to an access request and asks agent-auth for a decision.
The `verify()` middleware does this for [Hono](https://hono.dev):

```ts
import { Hono } from "hono";
import { onlineVerifier, verify } from "@superintelligenceco/agent-auth";

const app = new Hono();
const verifier = onlineVerifier({ baseUrl: "http://127.0.0.1:8787" });

app.post(
  "/repos/:owner/:repo/issues",
  verify({
    verifier,
    request: (c) => ({
      action: "github:issues:create",
      resource: `${c.req.param("owner")}/${c.req.param("repo")}`,
    }),
  }),
  (c) => c.json({ created: true }),
);
```

The middleware returns `401` without a token and `403` on denial. When a human must approve, it
returns `403` with `error.code: "approval_required"` and `error.approvalId`; the agent retries with
the `X-Agent-Auth-Approval` header. `verifyNode()` provides the same behavior for Express and other
Connect-style frameworks.

`offlineVerifier()` checks the signature, expiry and scopes locally with the public key, without a
network call. It cannot see revocations, use counts or approvals, so it denies approval scopes and
accepts a revoked token until it expires. Pair it with short TTLs.

### Credential proxy

[`examples/credential-proxy`](https://github.com/superintelligenceco/agent-auth/blob/main/examples/credential-proxy) holds a real upstream API key and injects it
only into requests that the presented agent token permits. The agent sends its agent token, the
proxy checks it against a route table, strips the agent's credentials, adds the real key and
forwards the request. Routes that are not in the table return `404`, and denied requests never reach
the upstream API.

```sh
AGENT_AUTH_URL=http://127.0.0.1:8787 UPSTREAM_API_KEY=<your GitHub token> \
  npx tsx examples/credential-proxy/main.ts
```

### MCP server

[`examples/mcp-server`](https://github.com/superintelligenceco/agent-auth/blob/main/examples/mcp-server) is a Model Context Protocol server whose `send_email`
and `charge_card` tools check the agent token before they act. A denied call returns a tool error
that states the reason. A call that needs approval returns the approval id, and the agent retries
with it once a human approves.

## SDK

Install the SDK with `npm install @superintelligenceco/agent-auth`. It needs Node.js 20 or later.

```ts
import { AgentAuthClient } from "@superintelligenceco/agent-auth";

const admin = new AgentAuthClient({
  baseUrl: "http://127.0.0.1:8787",
  adminToken: process.env.AGENT_AUTH_ADMIN_TOKEN,
});
const { token } = await admin.createGrant({
  principal: "alice",
  agent: "assistant",
  scopes: ["calendar:read", "calendar:write cal:work approval=required"],
  ttl: "2h",
});

const agent = new AgentAuthClient({ baseUrl: "http://127.0.0.1:8787" });
const res = await agent.check(token, { action: "calendar:read" });
// { decision: "allow", scope: "calendar:read", ... }
```

To embed the service in your own process instead of running the server, construct `AgentAuth`
with `openDatabase()` and `generateSigningKey()` or `loadOrCreateSigningKey()`. The scope matcher
is available on its own from `@superintelligenceco/agent-auth/scope`.
