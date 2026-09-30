/**
 * Stdio entry point. Register it in your MCP client, for example:
 *
 *   {
 *     "command": "npx",
 *     "args": ["tsx", "examples/mcp-server/main.ts"],
 *     "env": { "AGENT_AUTH_URL": "http://127.0.0.1:8787", "AGENT_AUTH_TOKEN": "<agent token>" }
 *   }
 *
 * The mailer and payment backends here only log to stderr.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { onlineVerifier } from "../../src/index.js";
import { createMcpServer } from "./server.js";

const token = process.env.AGENT_AUTH_TOKEN;
if (!token) {
  console.error("set AGENT_AUTH_TOKEN");
  process.exit(1);
}

const server = createMcpServer({
  verifier: onlineVerifier({ baseUrl: process.env.AGENT_AUTH_URL ?? "http://127.0.0.1:8787" }),
  token,
  mailer: {
    async send(m) {
      console.error(`[mailer] to=${m.to.join(",")} subject=${m.subject}`);
      return `sent to ${m.to.length} recipient(s)`;
    },
  },
  payments: {
    async charge(amount, currency, memo) {
      console.error(`[payments] ${amount} ${currency} ${memo}`);
      return `charged ${amount} ${currency}`;
    },
  },
});

await server.connect(new StdioServerTransport());
