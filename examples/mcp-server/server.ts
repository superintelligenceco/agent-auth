/**
 * An MCP server whose tools check an agent-auth token before they act.
 *
 * The MCP client (the agent) launches this server with its agent token in
 * AGENT_AUTH_TOKEN. Every tool call maps to an access request, and the server
 * refuses calls that the token does not permit. Scopes marked
 * `approval=required` return an approval id; the agent retries with it once a
 * human approves.
 *
 * In your own project, import from "@superintelligenceco/agent-auth" instead of "../../src/index.js".
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AccessRequest, Verifier } from "../../src/index.js";

export interface Mailer {
  send(msg: { to: string[]; subject: string; body: string }): Promise<string>;
}

export interface Payments {
  charge(amount: number, currency: string, memo: string): Promise<string>;
}

export interface McpOptions {
  verifier: Verifier;
  /** The agent token that this server process acts under. */
  token: string;
  mailer: Mailer;
  payments: Payments;
}

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

const text = (t: string, isError = false): ToolResult => ({
  content: [{ type: "text", text: t }],
  ...(isError ? { isError: true } : {}),
});

export function createMcpServer(opts: McpOptions): McpServer {
  const server = new McpServer({ name: "agent-auth-example", version: "0.1.0" });

  /** Runs `action` only when the token permits `request`. */
  async function guarded(
    request: AccessRequest,
    approvalId: string | undefined,
    action: () => Promise<string>,
  ): Promise<ToolResult> {
    const res = await opts.verifier.verify(opts.token, request, approvalId ? { approvalId } : {});
    if (res.decision === "approval_required") {
      return text(
        `A human must approve this call. Approval id: ${res.approvalId}. ` +
          "Retry with approvalId once it is approved.",
        true,
      );
    }
    if (res.decision !== "allow") return text(`Denied by agent-auth: ${res.reason}`, true);
    return text(await action());
  }

  server.registerTool(
    "send_email",
    {
      description: "Send an email on the user's behalf.",
      inputSchema: {
        to: z.array(z.string()).min(1),
        subject: z.string(),
        body: z.string(),
        approvalId: z.string().optional(),
      },
    },
    ({ to, subject, body, approvalId }) =>
      guarded({ action: "gmail:send", params: { to } }, approvalId, () =>
        opts.mailer.send({ to, subject, body }),
      ),
  );

  server.registerTool(
    "charge_card",
    {
      description: "Charge the user's card.",
      inputSchema: {
        amount: z.number().positive(),
        currency: z.string().regex(/^[A-Z]{3}$/),
        memo: z.string(),
        approvalId: z.string().optional(),
      },
    },
    ({ amount, currency, memo, approvalId }) =>
      guarded({ action: "payments:charge", amount: { value: amount, currency } }, approvalId, () =>
        opts.payments.charge(amount, currency, memo),
      ),
  );

  return server;
}
