import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { verifyChain } from "../src/audit.js";
import { AgentAuthClient, AgentAuthError } from "../src/client.js";
import { type RunningServer, runServer } from "../src/run.js";

const ADMIN = "test-admin-token-0123456789";
let dir: string;
let srv: RunningServer;
let admin: AgentAuthClient;
let agent: AgentAuthClient;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "agent-auth-"));
  srv = await runServer({
    dbPath: join(dir, "db.sqlite"),
    keyPath: join(dir, "key.pem"),
    adminToken: ADMIN,
    port: 0,
  });
  admin = new AgentAuthClient({ baseUrl: srv.url, adminToken: ADMIN });
  agent = new AgentAuthClient({ baseUrl: srv.url });
});

afterAll(async () => {
  await srv.close();
  rmSync(dir, { recursive: true, force: true });
});

async function raw(path: string, init: RequestInit = {}) {
  const res = await fetch(`${srv.url}${path}`, init);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe("REST API", () => {
  it("serves health and JWKS", async () => {
    expect(await raw("/healthz")).toEqual({ status: 200, body: { ok: true } });
    const { keys } = await agent.jwks();
    expect(keys[0]).toMatchObject({ kty: "OKP", crv: "Ed25519", alg: "EdDSA" });
    expect(keys[0]).not.toHaveProperty("d");
  });

  it("protects principal endpoints with the admin token", async () => {
    await expect(
      agent.createGrant({ principal: "p", agent: "a", scopes: ["x:y"], ttl: "1m" }),
    ).rejects.toMatchObject({ code: "unauthorized" });
    const wrong = await raw("/v1/grants", { headers: { authorization: "Bearer wrong-token" } });
    expect(wrong.status).toBe(401);
    expect((await raw("/v1/audit")).status).toBe(401);
  });

  it("validates bodies", async () => {
    const res = await raw("/v1/grants", {
      method: "POST",
      headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" },
      body: "{not json",
    });
    expect(res).toMatchObject({ status: 400, body: { error: { code: "bad_request" } } });
    await expect(
      admin.createGrant({ principal: "p", agent: "a", scopes: ["x:y"], ttl: "forever" }),
    ).rejects.toMatchObject({ status: 400, code: "bad_request" });
    await expect(
      admin.createGrant({ principal: "p", agent: "a", scopes: ["NOT VALID"], ttl: "1m" }),
    ).rejects.toMatchObject({ status: 400, code: "invalid_scope" });
    expect((await raw("/nope")).status).toBe(404);
  });

  it("runs grant, check, attenuate, revoke and audit end to end", async () => {
    const g = await admin.createGrant({
      principal: "user:alice",
      agent: "agent:assistant",
      scopes: ["gmail:send to:*@acme.com", "github:repo:read acme/*"],
      ttl: "1h",
      maxUses: 20,
    });
    expect(g.grant.expiresAt).toBeDefined();

    const ok = await agent.check(g.token, {
      action: "github:repo:read",
      resource: "acme/widgets",
    });
    expect(ok).toMatchObject({ decision: "allow", remainingUses: 19 });

    const child = await agent.attenuate({
      token: g.token,
      scopes: ["github:repo:read acme/widgets"],
      ttl: "5m",
      agent: "agent:reviewer",
    });
    expect(child.claims.dep).toBe(1);
    await expect(
      agent.attenuate({ token: child.token, scopes: ["github:repo:read acme/*"] }),
    ).rejects.toMatchObject({ status: 403, code: "scope_escalation" });

    const detail = await admin.getGrant(g.grant.id);
    expect(detail.tokens).toHaveLength(2);

    await expect(agent.revokeJti(child.claims.jti)).rejects.toBeInstanceOf(AgentAuthError);
    const unauth = await raw("/v1/tokens/revoke", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jti: child.claims.jti }),
    });
    expect(unauth.status).toBe(401);
    expect((await admin.revokeJti(child.claims.jti, "done")).revoked).toEqual([child.claims.jti]);
    expect(await agent.introspect(child.token)).toEqual({ active: false, reason: "revoked" });
    expect((await agent.introspect(g.token)).active).toBe(true);

    expect((await agent.revokeToken(g.token)).revoked).toEqual([g.claims.jti]);
    expect(
      (await agent.check(g.token, { action: "github:repo:read", resource: "acme/widgets" }))
        .decision,
    ).toBe("deny");

    const entries = await admin.auditAll();
    expect(entries.length).toBeGreaterThanOrEqual(6);
    const local = verifyChain(entries);
    expect(local.ok).toBe(true);
    expect(await admin.serverVerifyAudit(local.head)).toMatchObject({ ok: true });
    expect((await admin.audit(entries.length - 2, 10)).entries).toHaveLength(2);
    expect(
      (await raw(`/v1/audit?limit=-1`, { headers: { authorization: `Bearer ${ADMIN}` } })).status,
    ).toBe(400);
  });

  it("handles the approval flow over HTTP", async () => {
    const g = await admin.createGrant({
      principal: "user:alice",
      agent: "agent:buyer",
      scopes: ["payments:charge max=200USD approval=required"],
      ttl: 600,
    });
    const req = { action: "payments:charge", amount: { value: 80, currency: "USD" } };
    const first = await agent.check(g.token, req);
    expect(first.decision).toBe("approval_required");
    const { approvals } = await admin.listApprovals("pending");
    expect(approvals.map((a) => a.id)).toContain(first.approvalId);
    await expect(admin.listApprovals("bogus" as never)).rejects.toMatchObject({ status: 400 });
    expect((await admin.approve(first.approvalId as string, "fine")).status).toBe("approved");
    await expect(admin.deny(first.approvalId as string)).rejects.toMatchObject({ status: 409 });
    const redeemed = await agent.check(g.token, req, { approvalId: first.approvalId as string });
    expect(redeemed.decision).toBe("allow");
    await admin.revokeGrant(g.grant.id, "cleanup");
    expect((await admin.listGrants("user:alice")).grants.length).toBeGreaterThan(0);
  });

  it("keeps the signing key across restarts", async () => {
    const before = (await agent.jwks()).keys[0];
    const again = await runServer({
      dbPath: join(dir, "db.sqlite"),
      keyPath: join(dir, "key.pem"),
      adminToken: ADMIN,
      port: 0,
      issuer: srv.issuer,
    });
    try {
      const after = (await new AgentAuthClient({ baseUrl: again.url }).jwks()).keys[0];
      expect(after).toEqual(before);
    } finally {
      await again.close();
    }
  });

  it("refuses a short admin token", async () => {
    await expect(
      runServer({ dbPath: ":memory:", keyPath: join(dir, "k2.pem"), adminToken: "short", port: 0 }),
    ).rejects.toThrow(/16 characters/);
  });
});
