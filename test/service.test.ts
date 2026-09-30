import { describe, expect, it } from "vitest";
import { generateSigningKey } from "../src/keys.js";
import { ServiceError } from "../src/service.js";
import { signToken } from "../src/tokens.js";
import { ISSUER, makeService } from "./helpers.js";

const GMAIL = "gmail:send to:*@acme.com";
const send = (to: string) => ({ action: "gmail:send", params: { to } });

async function rejects(p: Promise<unknown> | (() => unknown), code: string) {
  const run = typeof p === "function" ? Promise.resolve().then(p) : p;
  await expect(run).rejects.toSatisfy((e) => e instanceof ServiceError && e.code === code);
}

describe("grants", () => {
  it("creates a grant with a signed root token", async () => {
    const { service } = await makeService();
    const res = await service.createGrant({
      principal: "user:alice",
      agent: "agent:mailer",
      scopes: [GMAIL, GMAIL, "calendar:read"],
      ttlSeconds: 3600,
      maxUses: 5,
    });
    expect(res.grant.scopes).toEqual([GMAIL, "calendar:read"]);
    expect(res.claims).toMatchObject({
      iss: ISSUER,
      sub: "agent:mailer",
      prn: "user:alice",
      gnt: res.grant.id,
      dep: 0,
      mxu: 5,
    });
    expect(res.claims.exp - res.claims.iat).toBe(3600);
    expect(res.token.split(".")).toHaveLength(3);
    expect(service.listGrants({ principal: "user:alice" })).toHaveLength(1);
    expect(service.listGrants({ principal: "user:bob" })).toHaveLength(0);
    expect(service.grantTokens(res.grant.id)).toHaveLength(1);
  });

  it("validates input", async () => {
    const { service } = await makeService({ maxTtlSeconds: 600 });
    const base = { principal: "p", agent: "a", scopes: [GMAIL], ttlSeconds: 60 };
    await rejects(service.createGrant({ ...base, principal: "" }), "bad_request");
    await rejects(service.createGrant({ ...base, agent: "has space" }), "bad_request");
    await rejects(service.createGrant({ ...base, scopes: [] }), "invalid_scope");
    await rejects(service.createGrant({ ...base, scopes: ["Bad Scope"] }), "invalid_scope");
    await rejects(service.createGrant({ ...base, ttlSeconds: 601 }), "bad_request");
    await rejects(service.createGrant({ ...base, ttlSeconds: 0 }), "bad_request");
    await rejects(service.createGrant({ ...base, maxUses: 0 }), "bad_request");
    await rejects(() => service.getGrant("nope"), "not_found");
  });
});

describe("check", () => {
  it("allows, denies and audits", async () => {
    const { service } = await makeService();
    const { token } = await service.createGrant({
      principal: "alice",
      agent: "mailer",
      scopes: [GMAIL],
      ttlSeconds: 60,
    });
    expect((await service.check({ token, request: send("bob@acme.com") })).decision).toBe("allow");
    const denied = await service.check({ token, request: send("eve@evil.io") });
    expect(denied).toMatchObject({
      decision: "deny",
      reason: "to eve@evil.io does not match *@acme.com (scope: gmail:send to:*@acme.com)",
    });
    const checks = service.auditEntries().filter((e) => e.type === "check");
    expect(checks.map((e) => e.data.decision)).toEqual(["allow", "deny"]);
    expect(checks[0]?.actor).toBe("agent:mailer");
  });

  it("denies garbage, forged and foreign tokens", async () => {
    const { service } = await makeService();
    expect((await service.check({ token: "nope", request: send("a@acme.com") })).decision).toBe(
      "deny",
    );
    const other = await generateSigningKey("test");
    const forged = await signToken(
      {
        iss: ISSUER,
        sub: "mailer",
        jti: "tk_forged",
        iat: 0,
        exp: 2e9,
        prn: "alice",
        gnt: "gr_x",
        scp: ["*"],
        dep: 0,
      },
      other,
    );
    const res = await service.check({ token: forged, request: send("a@acme.com") });
    expect(res).toEqual({ decision: "deny", reason: "invalid_token" });
    await rejects(service.check({ token: forged, request: {} as never }), "bad_request");
  });

  it("expires tokens", async () => {
    const { service, clock } = await makeService();
    const { token } = await service.createGrant({
      principal: "alice",
      agent: "mailer",
      scopes: [GMAIL],
      ttlSeconds: 60,
    });
    clock.advance(61);
    expect(await service.check({ token, request: send("a@acme.com") })).toEqual({
      decision: "deny",
      reason: "expired",
    });
    expect(await service.introspect(token)).toEqual({ active: false, reason: "expired" });
  });

  it("enforces max uses, and dry runs do not consume", async () => {
    const { service } = await makeService();
    const { token } = await service.createGrant({
      principal: "alice",
      agent: "mailer",
      scopes: [GMAIL],
      ttlSeconds: 60,
      maxUses: 2,
    });
    const req = send("a@acme.com");
    expect((await service.check({ token, request: req, dryRun: true })).remainingUses).toBe(2);
    expect((await service.check({ token, request: req })).remainingUses).toBe(1);
    expect((await service.check({ token, request: req })).remainingUses).toBe(0);
    expect(await service.check({ token, request: req })).toMatchObject({
      decision: "deny",
      reason: "max_uses_exceeded",
    });
  });
});

describe("attenuation", () => {
  async function setup() {
    const ctx = await makeService();
    const root = await ctx.service.createGrant({
      principal: "alice",
      agent: "planner",
      scopes: [GMAIL, "payments:charge max=50USD"],
      ttlSeconds: 3600,
      maxUses: 10,
    });
    return { ...ctx, root };
  }

  it("derives a narrower token for a sub-agent", async () => {
    const { service, root } = await setup();
    const child = await service.attenuate({
      token: root.token,
      scopes: ["gmail:send to:bob@acme.com"],
      ttlSeconds: 300,
      agent: "writer",
    });
    expect(child.claims).toMatchObject({
      sub: "writer",
      par: root.claims.jti,
      dep: 1,
      mxu: 10,
      prn: "alice",
    });
    expect(child.claims.exp - child.claims.iat).toBe(300);
    expect(
      (await service.check({ token: child.token, request: send("bob@acme.com") })).decision,
    ).toBe("allow");
    expect(
      (await service.check({ token: child.token, request: send("carol@acme.com") })).decision,
    ).toBe("deny");
    const intro = await service.introspect(child.token);
    expect(intro.active).toBe(true);
    expect(intro.chain?.map((t) => t.jti)).toEqual([root.claims.jti, child.claims.jti]);
    // Both tokens in the chain consumed a use.
    expect(intro.chain?.map((t) => t.uses)).toEqual([1, 1]);
  });

  it("rejects escalation and records the attempt", async () => {
    const { service, root } = await setup();
    await expect(
      service.attenuate({
        token: root.token,
        scopes: ["gmail:send", "payments:charge max=100USD"],
      }),
    ).rejects.toMatchObject({
      code: "scope_escalation",
      details: { uncovered: ["gmail:send", "payments:charge max=100USD"] },
    });
    const denied = service.auditEntries().find((e) => e.type === "token.attenuation_denied");
    expect(denied?.data.uncovered).toEqual(["gmail:send", "payments:charge max=100USD"]);
  });

  it("caps lifetime and uses at the parent's", async () => {
    const { service, root, clock } = await setup();
    const child = await service.attenuate({
      token: root.token,
      scopes: [GMAIL],
      ttlSeconds: 86400,
      maxUses: 99,
    });
    expect(child.claims.exp).toBe(root.claims.exp);
    expect(child.claims.mxu).toBe(10);
    clock.advance(3601);
    expect((await service.introspect(child.token)).active).toBe(false);
  });

  it("limits delegation depth", async () => {
    const { service } = await makeService({ maxDepth: 2 });
    let { token } = await service.createGrant({
      principal: "alice",
      agent: "a",
      scopes: [GMAIL],
      ttlSeconds: 60,
    });
    token = (await service.attenuate({ token, scopes: [GMAIL] })).token;
    token = (await service.attenuate({ token, scopes: [GMAIL] })).token;
    await rejects(service.attenuate({ token, scopes: [GMAIL] }), "depth_exceeded");
  });

  it("shares use limits across the chain", async () => {
    const { service, root } = await setup();
    const a = await service.attenuate({ token: root.token, scopes: [GMAIL], maxUses: 3 });
    for (let i = 0; i < 3; i++) {
      expect((await service.check({ token: a.token, request: send("x@acme.com") })).decision).toBe(
        "allow",
      );
    }
    expect((await service.check({ token: a.token, request: send("x@acme.com") })).reason).toBe(
      "max_uses_exceeded",
    );
    // The parent has 7 uses left.
    const res = await service.check({ token: root.token, request: send("x@acme.com") });
    expect(res.remainingUses).toBe(6);
  });
});

describe("revocation", () => {
  it("revokes a token and all of its descendants", async () => {
    const { service } = await makeService();
    const root = await service.createGrant({
      principal: "alice",
      agent: "a",
      scopes: [GMAIL],
      ttlSeconds: 60,
    });
    const child = await service.attenuate({ token: root.token, scopes: [GMAIL] });
    const grandchild = await service.attenuate({ token: child.token, scopes: [GMAIL] });
    const sibling = await service.attenuate({ token: root.token, scopes: [GMAIL] });

    const res = service.revokeToken(child.claims.jti);
    expect(res.revoked.sort()).toEqual([child.claims.jti, grandchild.claims.jti].sort());
    expect(await service.introspect(grandchild.token)).toEqual({
      active: false,
      reason: "revoked",
    });
    expect((await service.introspect(sibling.token)).active).toBe(true);
    expect((await service.introspect(root.token)).active).toBe(true);
    expect(service.revokeToken(child.claims.jti).revoked).toEqual([]);
    await rejects(() => service.revokeToken("tk_missing"), "not_found");
  });

  it("lets an agent revoke its own token", async () => {
    const { service } = await makeService();
    const root = await service.createGrant({
      principal: "alice",
      agent: "a",
      scopes: [GMAIL],
      ttlSeconds: 60,
    });
    await service.revokeSelf(root.token, "done");
    expect((await service.introspect(root.token)).active).toBe(false);
    const entry = service.auditEntries().find((e) => e.type === "token.revoked");
    expect(entry).toMatchObject({ actor: "agent:a", data: { reason: "done" } });
  });

  it("revokes a whole grant", async () => {
    const { service } = await makeService();
    const root = await service.createGrant({
      principal: "alice",
      agent: "a",
      scopes: [GMAIL],
      ttlSeconds: 60,
    });
    const child = await service.attenuate({ token: root.token, scopes: [GMAIL] });
    expect(service.revokeGrant(root.grant.id).revoked).toHaveLength(2);
    expect(service.getGrant(root.grant.id).revokedAt).toBeDefined();
    expect((await service.check({ token: child.token, request: send("a@acme.com") })).reason).toBe(
      "revoked",
    );
    await rejects(service.attenuate({ token: child.token, scopes: [GMAIL] }), "revoked");
  });
});

describe("approvals", () => {
  async function setup() {
    const ctx = await makeService();
    const root = await ctx.service.createGrant({
      principal: "alice",
      agent: "buyer",
      scopes: ["payments:charge max=500USD approval=required"],
      ttlSeconds: 3600,
    });
    const req = { action: "payments:charge", amount: { value: 120, currency: "USD" } };
    return { ...ctx, token: root.token, req };
  }

  it("runs the request, approve, redeem flow once", async () => {
    const { service, token, req } = await setup();
    const first = await service.check({ token, request: req });
    expect(first.decision).toBe("approval_required");
    const id = first.approvalId as string;
    // Asking again reuses the pending approval.
    expect((await service.check({ token, request: req })).approvalId).toBe(id);
    expect(service.listApprovals("pending")).toHaveLength(1);

    const pending = await service.check({ token, request: req, approvalId: id });
    expect(pending).toMatchObject({ decision: "approval_required", reason: "approval is pending" });

    expect(service.decideApproval(id, true, "ok").status).toBe("approved");
    // An approval only covers the exact request it was created for.
    const other = await service.check({
      token,
      request: { ...req, amount: { value: 499, currency: "USD" } },
      approvalId: id,
    });
    expect(other.decision).toBe("deny");

    const redeemed = await service.check({ token, request: req, approvalId: id });
    expect(redeemed).toMatchObject({
      decision: "allow",
      reason: "matched scope, approved by a human",
    });
    expect(service.getApproval(id).status).toBe("consumed");
    expect((await service.check({ token, request: req, approvalId: id })).decision).toBe("deny");
    expect(() => service.decideApproval(id, false)).toThrow(ServiceError);
  });

  it("denies after a human denies", async () => {
    const { service, token, req } = await setup();
    const { approvalId } = await service.check({ token, request: req });
    service.decideApproval(approvalId as string, false, "too much");
    const res = await service.check({ token, request: req, approvalId: approvalId as string });
    expect(res).toMatchObject({ decision: "deny", reason: "approval is denied" });
  });

  it("does not create approvals on a dry run", async () => {
    const { service, token, req } = await setup();
    const res = await service.check({ token, request: req, dryRun: true });
    expect(res.decision).toBe("approval_required");
    expect(res.approvalId).toBeUndefined();
    expect(service.listApprovals()).toHaveLength(0);
  });

  it("keeps approval on attenuated tokens", async () => {
    const { service, token } = await setup();
    await rejects(
      service.attenuate({ token, scopes: ["payments:charge max=10USD"] }),
      "scope_escalation",
    );
    const child = await service.attenuate({
      token,
      scopes: ["payments:charge max=10USD approval=required"],
    });
    const res = await service.check({
      token: child.token,
      request: { action: "payments:charge", amount: { value: 5, currency: "USD" } },
    });
    expect(res.decision).toBe("approval_required");
  });
});

describe("audit", () => {
  it("records every event in a verifiable chain", async () => {
    const { service } = await makeService();
    const root = await service.createGrant({
      principal: "alice",
      agent: "a",
      scopes: [GMAIL],
      ttlSeconds: 60,
    });
    await service.check({ token: root.token, request: send("a@acme.com") });
    await service.attenuate({ token: root.token, scopes: [GMAIL] });
    service.revokeGrant(root.grant.id);
    const types = service.auditEntries().map((e) => e.type);
    expect(types).toEqual(["grant.created", "check", "token.attenuated", "grant.revoked"]);
    const v = service.verifyAudit();
    expect(v).toMatchObject({ ok: true, count: 4 });
    expect(service.verifyAudit(v.head).ok).toBe(true);
    expect(service.verifyAudit("f".repeat(64)).ok).toBe(false);
    expect(service.jwks().keys).toHaveLength(1);
  });
});
