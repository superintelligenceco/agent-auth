import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AgentAuthClient, onlineVerifier, type RunningServer, runServer } from "../../src/index.js";
import { createMcpServer } from "./server.js";

const ADMIN = "test-admin-token-0123456789";
let dir: string;
let srv: RunningServer;
let admin: AgentAuthClient;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "agent-auth-mcp-"));
  srv = await runServer({
    dbPath: ":memory:",
    keyPath: join(dir, "k.pem"),
    adminToken: ADMIN,
    port: 0,
  });
  admin = new AgentAuthClient({ baseUrl: srv.url, adminToken: ADMIN });
});

afterAll(async () => {
  await srv.close();
  rmSync(dir, { recursive: true, force: true });
});

function firstText(res: unknown): string {
  return (res as { content: { text: string }[] }).content[0]?.text ?? "";
}

describe("MCP example", () => {
  it("guards tool calls with the agent token", async () => {
    const { token } = await admin.createGrant({
      principal: "alice",
      agent: "assistant",
      scopes: ["gmail:send to:*@acme.com", "payments:charge max=100USD approval=required"],
      ttl: "10m",
    });
    const sent: string[][] = [];
    const charged: number[] = [];
    const server = createMcpServer({
      verifier: onlineVerifier({ baseUrl: srv.url }),
      token,
      mailer: {
        send: async (m) => {
          sent.push(m.to);
          return "sent";
        },
      },
      payments: {
        charge: async (a) => {
          charged.push(a);
          return "charged";
        },
      },
    });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: "test", version: "0.0.0" });
    await client.connect(clientSide);

    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name).sort()).toEqual(["charge_card", "send_email"]);

    const ok = await client.callTool({
      name: "send_email",
      arguments: { to: ["bob@acme.com"], subject: "hi", body: "hello" },
    });
    expect(ok.isError).toBeFalsy();
    expect(sent).toEqual([["bob@acme.com"]]);

    const bad = await client.callTool({
      name: "send_email",
      arguments: { to: ["bob@acme.com", "leak@evil.io"], subject: "hi", body: "x" },
    });
    expect(bad.isError).toBe(true);
    expect(firstText(bad)).toContain("Denied by agent-auth");
    expect(sent).toHaveLength(1);

    const args = { amount: 40, currency: "USD", memo: "domain renewal" };
    const pending = await client.callTool({ name: "charge_card", arguments: args });
    expect(pending.isError).toBe(true);
    const approvalId = /Approval id: (\S+)\./.exec(firstText(pending))?.[1] as string;
    expect(approvalId).toMatch(/^ap_/);
    expect(charged).toEqual([]);

    await admin.approve(approvalId);
    const paid = await client.callTool({ name: "charge_card", arguments: { ...args, approvalId } });
    expect(paid.isError).toBeFalsy();
    expect(charged).toEqual([40]);

    await client.close();
  });
});
