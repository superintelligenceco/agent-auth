import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AgentAuthClient, onlineVerifier, type RunningServer, runServer } from "../../src/index.js";
import { createCredentialProxy, githubRules } from "./proxy.js";

const ADMIN = "test-admin-token-0123456789";
const SECRET = `ghp_test_${Math.random().toString(36).slice(2)}`;

let dir: string;
let srv: RunningServer;
let admin: AgentAuthClient;
const seen: { url: string; auth: string | null; body: string }[] = [];

/** Fake upstream API that records what it receives. */
const upstream: typeof fetch = async (input, init) => {
  const req = new Request(input, init);
  seen.push({ url: req.url, auth: req.headers.get("authorization"), body: await req.text() });
  return Response.json({ ok: true, echoedAuth: "hidden" }, { headers: { "set-cookie": "s=1" } });
};

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "agent-auth-proxy-"));
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

describe("credential proxy", () => {
  it("injects the secret only for permitted requests", async () => {
    const { token } = await admin.createGrant({
      principal: "alice",
      agent: "triager",
      scopes: ["github:issues:read acme/*", "github:issues:create acme/widgets label:bug"],
      ttl: "10m",
    });
    const proxy = createCredentialProxy({
      verifier: onlineVerifier({ baseUrl: srv.url }),
      upstream: "https://api.example.test",
      inject: { header: "authorization", value: `Bearer ${SECRET}` },
      rules: githubRules,
      fetch: upstream,
    });
    const auth = { authorization: `Bearer ${token}` };

    const read = await proxy.request("/repos/acme/widgets/issues?state=open", { headers: auth });
    expect(read.status).toBe(200);
    expect(read.headers.get("set-cookie")).toBeNull();
    expect(await read.text()).not.toContain(SECRET);
    expect(seen.at(-1)).toMatchObject({
      url: "https://api.example.test/repos/acme/widgets/issues?state=open",
      auth: `Bearer ${SECRET}`,
    });

    const create = await proxy.request("/repos/acme/widgets/issues", {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ title: "Crash", labels: ["bug"] }),
    });
    expect(create.status).toBe(200);
    expect(JSON.parse(seen.at(-1)?.body ?? "{}")).toEqual({ title: "Crash", labels: ["bug"] });

    const before = seen.length;
    const wrongLabel = await proxy.request("/repos/acme/widgets/issues", {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ title: "x", labels: ["bug", "security"] }),
    });
    expect(wrongLabel.status).toBe(403);
    const otherRepo = await proxy.request("/repos/evil/repo/issues", { headers: auth });
    expect(otherRepo.status).toBe(403);
    const unlisted = await proxy.request("/user/keys", { headers: auth });
    expect(unlisted.status).toBe(404);
    const anonymous = await proxy.request("/repos/acme/widgets/issues");
    expect(anonymous.status).toBe(401);
    // None of the rejected requests reached the upstream API.
    expect(seen.length).toBe(before);
  });
});
