import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AgentAuthClient } from "../src/client.js";
import {
  APPROVAL_HEADER,
  bearerToken,
  offlineVerifier,
  onlineVerifier,
  verify,
  verifyNode,
} from "../src/middleware.js";
import { type RunningServer, runServer } from "../src/run.js";

const ADMIN = "test-admin-token-0123456789";
let dir: string;
let srv: RunningServer;
let admin: AgentAuthClient;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "agent-auth-mw-"));
  srv = await runServer({
    dbPath: ":memory:",
    keyPath: join(dir, "key.pem"),
    adminToken: ADMIN,
    port: 0,
  });
  admin = new AgentAuthClient({ baseUrl: srv.url, adminToken: ADMIN });
});

afterAll(async () => {
  await srv.close();
  rmSync(dir, { recursive: true, force: true });
});

function toolApp(verifier: ReturnType<typeof onlineVerifier>) {
  const app = new Hono();
  app.post(
    "/repos/:owner/:repo/issues",
    verify({
      verifier,
      request: (c) => ({
        action: "github:issues:create",
        resource: `${c.req.param("owner")}/${c.req.param("repo")}`,
      }),
    }),
    (c) => c.json({ created: true, by: (c.get("agentAuth" as never) as { agent: string }).agent }),
  );
  return app;
}

describe("bearerToken", () => {
  it("parses the header", () => {
    expect(bearerToken("Bearer abc")).toBe("abc");
    expect(bearerToken("bearer abc ")).toBe("abc");
    expect(bearerToken("Basic abc")).toBeUndefined();
    expect(bearerToken(undefined)).toBeUndefined();
  });
});

describe("verify() with the online verifier", () => {
  it("allows, denies and handles approvals", async () => {
    const g = await admin.createGrant({
      principal: "alice",
      agent: "triager",
      scopes: ["github:issues:create acme/*", "github:issues:create other/* approval=required"],
      ttl: "10m",
    });
    const app = toolApp(onlineVerifier({ baseUrl: srv.url }));
    const call = (path: string, headers: Record<string, string> = {}) =>
      app.request(path, { method: "POST", headers });

    expect((await call("/repos/acme/widgets/issues")).status).toBe(401);

    const ok = await call("/repos/acme/widgets/issues", { authorization: `Bearer ${g.token}` });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ created: true, by: "triager" });

    const denied = await call("/repos/evil/x/issues", { authorization: `Bearer ${g.token}` });
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ error: { code: "forbidden" } });

    const needs = await call("/repos/other/x/issues", { authorization: `Bearer ${g.token}` });
    const body = (await needs.json()) as { error: { code: string; approvalId: string } };
    expect(needs.status).toBe(403);
    expect(body.error.code).toBe("approval_required");
    await admin.approve(body.error.approvalId);
    const approved = await call("/repos/other/x/issues", {
      authorization: `Bearer ${g.token}`,
      [APPROVAL_HEADER]: body.error.approvalId,
    });
    expect(approved.status).toBe(200);
  });

  it("fails closed when the server errors", async () => {
    const verifier = onlineVerifier({
      baseUrl: "http://agent-auth.invalid",
      fetch: async () => new Response("boom", { status: 502 }),
    });
    const res = await verifier.verify("t", { action: "a:b" });
    expect(res).toEqual({ decision: "deny", reason: "agent-auth server returned HTTP 502" });
  });

  it("supports a custom header", async () => {
    const g = await admin.createGrant({
      principal: "alice",
      agent: "a",
      scopes: ["x:y"],
      ttl: "1m",
    });
    const app = new Hono();
    app.get(
      "/",
      verify({
        verifier: onlineVerifier({ baseUrl: srv.url }),
        header: "x-agent-token",
        request: () => ({ action: "x:y" }),
      }),
      (c) => c.text("ok"),
    );
    expect((await app.request("/", { headers: { "x-agent-token": g.token } })).status).toBe(200);
  });
});

describe("offlineVerifier", () => {
  it("checks signature and scope without the server", async () => {
    const g = await admin.createGrant({
      principal: "alice",
      agent: "a",
      scopes: ["x:read", "x:write approval=required"],
      ttl: "1m",
    });
    const { keys } = await admin.jwks();
    const v = offlineVerifier({ issuer: srv.issuer, publicJwk: keys[0] as never });
    expect((await v.verify(g.token, { action: "x:read" })).decision).toBe("allow");
    expect((await v.verify(g.token, { action: "x:delete" })).decision).toBe("deny");
    expect((await v.verify(g.token, { action: "x:write" })).reason).toMatch(/offline/);
    expect(await v.verify("garbage", { action: "x:read" })).toEqual({
      decision: "deny",
      reason: "invalid_token",
    });
    const wrongIssuer = offlineVerifier({ issuer: "https://other", publicJwk: keys[0] as never });
    expect((await wrongIssuer.verify(g.token, { action: "x:read" })).decision).toBe("deny");
    const later = offlineVerifier({
      issuer: srv.issuer,
      jwksUrl: `${srv.url}/.well-known/jwks.json`,
      now: () => new Date(Date.now() + 3600_000),
    });
    expect(await later.verify(g.token, { action: "x:read" })).toEqual({
      decision: "deny",
      reason: "expired",
    });
    expect(() => offlineVerifier({ issuer: "x" })).toThrow();
  });
});

describe("verifyNode", () => {
  it("works as Connect-style middleware", async () => {
    const g = await admin.createGrant({
      principal: "alice",
      agent: "a",
      scopes: ["files:read reports/*"],
      ttl: "1m",
    });
    const mw = verifyNode({
      verifier: onlineVerifier({ baseUrl: srv.url }),
      request: (req: { url?: string; headers: Record<string, string | string[] | undefined> }) => ({
        action: "files:read",
        resource: (req.url ?? "/").slice(1),
      }),
    });
    const http = createServer((req, res) => {
      void mw(req as never, res, (err) => {
        res.statusCode = err ? 500 : 200;
        res.end(err ? "error" : "file contents");
      });
    });
    await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
    try {
      const auth = { authorization: `Bearer ${g.token}` };
      expect((await fetch(`${base}/reports/q1`, { headers: auth })).status).toBe(200);
      expect((await fetch(`${base}/secrets/keys`, { headers: auth })).status).toBe(403);
      expect((await fetch(`${base}/reports/q1`)).status).toBe(401);
    } finally {
      http.close();
    }
  });
});
