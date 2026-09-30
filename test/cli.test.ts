import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openDatabase } from "../src/db.js";
import { type RunningServer, runServer } from "../src/run.js";

const run = promisify(execFile);
const ADMIN = "test-admin-token-0123456789";
const CLI = join(import.meta.dirname, "..", "src", "cli.ts");

let dir: string;
let srv: RunningServer;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "agent-auth-cli-"));
  srv = await runServer({
    dbPath: join(dir, "db.sqlite"),
    keyPath: join(dir, "key.pem"),
    adminToken: ADMIN,
    port: 0,
  });
});

afterAll(async () => {
  await srv.close();
  rmSync(dir, { recursive: true, force: true });
});

async function cli(args: string[], env: Record<string, string> = {}) {
  try {
    const { stdout, stderr } = await run(process.execPath, ["--import", "tsx", CLI, ...args], {
      env: { ...process.env, AGENT_AUTH_URL: srv.url, ...env },
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code: number; stdout: string; stderr: string };
    return { code: e.code, stdout: e.stdout, stderr: e.stderr };
  }
}

const asAdmin = { AGENT_AUTH_ADMIN_TOKEN: ADMIN };

describe("agent-auth CLI", () => {
  it("prints the version", async () => {
    const res = await cli(["--version"]);
    expect(res.code).toBe(0);
    expect(res.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("prints help", async () => {
    const res = await cli(["--help"]);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("Usage: agent-auth <command>");
    expect((await cli(["bogus"])).stderr).toContain('unknown command "bogus"');
  });

  it("runs grant, check, attenuate, inspect, revoke and audit verify", async () => {
    const grant = await cli(
      [
        "grant",
        "--principal",
        "user:alice",
        "--agent",
        "agent:assistant",
        "--scope",
        "gmail:send to:*@acme.com",
        "--scope",
        "payments:charge max=50USD",
        "--ttl",
        "1h",
        "--max-uses",
        "5",
        "-q",
      ],
      asAdmin,
    );
    expect(grant.code).toBe(0);
    const token = grant.stdout.trim();
    const withToken = { AGENT_AUTH_TOKEN: token };

    const allow = await cli(
      ["check", "--action", "gmail:send", "--param", "to=bob@acme.com"],
      withToken,
    );
    expect(allow.code).toBe(0);
    expect(allow.stdout).toMatch(/^ALLOW/);
    expect(allow.stdout).toContain("4 uses left");

    const deny = await cli(
      ["check", "--action", "payments:charge", "--amount", "80USD"],
      withToken,
    );
    expect(deny.code).toBe(3);
    expect(deny.stdout).toMatch(/^DENY/);

    const escalate = await cli(["attenuate", "--scope", "gmail:send"], withToken);
    expect(escalate.code).toBe(1);
    expect(escalate.stderr).toContain("not covered by parent: gmail:send");

    const child = await cli(
      ["attenuate", "--scope", "gmail:send to:bob@acme.com", "--agent", "agent:sub", "-q"],
      withToken,
    );
    expect(child.code).toBe(0);
    const childToken = child.stdout.trim();

    const inspect = await cli(["inspect", "--token", childToken]);
    expect(inspect.stdout).toContain("agent     agent:sub");
    expect(inspect.stdout).toContain("status    active");

    const revoke = await cli(["revoke", "--token", token]);
    expect(revoke.stdout).toContain("revoked 2 token(s)");
    const after = await cli(["inspect", "--token", childToken]);
    expect(after.code).toBe(3);
    expect(after.stdout).toContain("inactive (revoked)");

    const log = await cli(["audit", "log"], asAdmin);
    expect(log.stdout).toContain("grant.created");
    expect(log.stdout).toContain("token.attenuation_denied");

    const verified = await cli(["audit", "verify"], asAdmin);
    expect(verified.code).toBe(0);
    expect(verified.stdout).toMatch(/^OK\s+\d+ entries, chain intact/);
  });

  it("handles approvals", async () => {
    const token = (
      await cli(
        [
          "grant",
          "--principal",
          "alice",
          "--agent",
          "buyer",
          "--scope",
          "payments:charge max=100USD approval=required",
          "-q",
        ],
        asAdmin,
      )
    ).stdout.trim();
    const args = ["check", "--token", token, "--action", "payments:charge", "--amount", "40USD"];
    const pending = await cli(args);
    expect(pending.code).toBe(4);
    const id = /approval (ap_\S+)/.exec(pending.stdout)?.[1] as string;
    expect((await cli(["approvals"], asAdmin)).stdout).toContain(id);
    expect((await cli(["approve", id], asAdmin)).stdout).toBe(`${id} approved\n`);
    expect((await cli([...args, "--approval", id])).code).toBe(0);
  });

  it("detects a tampered database file", async () => {
    const dbPath = join(dir, "tampered.sqlite");
    const other = await runServer({
      dbPath,
      keyPath: join(dir, "key.pem"),
      adminToken: ADMIN,
      port: 0,
    });
    await cli(
      ["grant", "--principal", "p", "--agent", "a", "--scope", "x:y", "--url", other.url],
      asAdmin,
    );
    await other.close();
    expect((await cli(["audit", "verify", "--db", dbPath])).code).toBe(0);

    const db = openDatabase(dbPath);
    db.exec("DROP TRIGGER audit_no_update");
    db.prepare(`UPDATE audit SET actor = 'someone-else' WHERE seq = 1`).run();
    db.close();

    const res = await cli(["audit", "verify", "--db", dbPath]);
    expect(res.code).toBe(1);
    expect((await cli(["audit", "verify", "--db", join(dir, "missing.sqlite")])).code).toBe(1);
    expect(res.stdout).toContain("TAMPERED");
    expect(res.stdout).toContain("first bad entry: seq 1");
  });

  it("reports an unreachable server", async () => {
    const res = await cli(["check", "--token", "x", "--action", "a:b"], {
      AGENT_AUTH_URL: "http://127.0.0.1:1",
    });
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("cannot reach the agent-auth server");
  });
});
