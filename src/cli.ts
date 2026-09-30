#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { type AuditEntry, verifyChain } from "./audit.js";
import { AgentAuthClient, AgentAuthError } from "./client.js";
import { iterateAudit, listAudit, openDatabase } from "./db.js";
import { formatDuration } from "./duration.js";
import { runServer } from "./run.js";
import { type AccessRequest, parseAmount } from "./scope/index.js";
import type { CheckResult } from "./service.js";
import { decodeToken } from "./tokens.js";

const HELP = `agent-auth: scoped, expiring, auditable credentials for AI agents

Usage: agent-auth <command> [options]

Server
  serve                      Start the REST server
      --port <n>             Port (default 8787, env AGENT_AUTH_PORT)
      --host <addr>          Bind address (default 127.0.0.1, env AGENT_AUTH_HOST)
      --db <path>            SQLite file (default ./data/agent-auth.db, env AGENT_AUTH_DB)
      --key <path>           Signing key file (default ./data/signing-key.pem, env AGENT_AUTH_KEY)
      --issuer <url>         Issuer URL placed in tokens (env AGENT_AUTH_ISSUER)

Principal commands (need AGENT_AUTH_ADMIN_TOKEN)
  grant                      Delegate scopes to an agent and print its token
      --principal <id>       Who delegates (required)
      --agent <id>           Who receives the grant (required)
      --scope <scope>        Scope, repeatable (required)
      --ttl <dur>            Lifetime such as 15m, 1h, 7d (default 1h)
      --max-uses <n>         Maximum number of allowed uses
  revoke <jti>               Revoke a token and everything derived from it
  revoke --grant <id>        Revoke a whole grant
  approvals [--status s]     List approval requests (default: pending)
  approve <id> | deny <id>   Decide a pending approval
  audit log                  Print audit entries
  audit verify               Verify the audit hash chain
      --db <path>            Read the SQLite file directly instead of the server
      --head <hash>          Fail unless this previously anchored head is in the chain

Agent commands
  attenuate                  Derive a narrower token from --token
      --scope <scope>        Scope, repeatable (required)
      --ttl <dur>            Lifetime, capped at the parent's expiry
      --max-uses <n>         Maximum number of allowed uses
      --agent <id>           Sub-agent that receives the token
  check                      Ask whether --token permits a request (consumes a use)
      --action <a>           Concrete action, for example gmail:send (required)
      --resource <r>         Resource, for example acme/widgets
      --param <k=v>          Request parameter, repeatable
      --amount <amt>         Amount, for example 20USD
      --approval <id>        Approved approval id to redeem
      --dry-run              Evaluate without consuming a use
  inspect                    Decode --token and show its live status
  revoke --token <t>         Revoke the presented token and its descendants

Global options
  --url <url>                Server URL (default http://127.0.0.1:8787, env AGENT_AUTH_URL)
  --token <t>                Agent token, or @file, or - for stdin (env AGENT_AUTH_TOKEN)
  --json                     Print raw JSON
  -q, --quiet                Print only the essential value (for example the token)
  -h, --help                 Show this help

Exit codes: 0 success or allow, 1 error, 3 deny, 4 approval required.
`;

const options = {
  help: { type: "boolean", short: "h" },
  json: { type: "boolean" },
  quiet: { type: "boolean", short: "q" },
  url: { type: "string" },
  "admin-token": { type: "string" },
  token: { type: "string" },
  port: { type: "string" },
  host: { type: "string" },
  db: { type: "string" },
  key: { type: "string" },
  issuer: { type: "string" },
  principal: { type: "string" },
  agent: { type: "string" },
  scope: { type: "string", multiple: true },
  ttl: { type: "string" },
  "max-uses": { type: "string" },
  action: { type: "string" },
  resource: { type: "string" },
  param: { type: "string", multiple: true },
  amount: { type: "string" },
  approval: { type: "string" },
  "dry-run": { type: "boolean" },
  grant: { type: "string" },
  status: { type: "string" },
  head: { type: "string" },
  after: { type: "string" },
  limit: { type: "string" },
  reason: { type: "string" },
  note: { type: "string" },
} as const;

type Values = ReturnType<
  typeof parseArgs<{ options: typeof options; allowPositionals: true }>
>["values"];

class UsageError extends Error {}

const env = process.env;

function out(line = ""): void {
  process.stdout.write(`${line}\n`);
}

function readToken(v: Values): string {
  const raw = v.token ?? env.AGENT_AUTH_TOKEN;
  if (!raw) throw new UsageError("--token is required (or set AGENT_AUTH_TOKEN)");
  if (raw === "-") return readFileSync(0, "utf8").trim();
  if (raw.startsWith("@")) return readFileSync(raw.slice(1), "utf8").trim();
  return raw.trim();
}

function client(v: Values): AgentAuthClient {
  const adminToken = v["admin-token"] ?? env.AGENT_AUTH_ADMIN_TOKEN;
  return new AgentAuthClient({
    baseUrl: v.url ?? env.AGENT_AUTH_URL ?? "http://127.0.0.1:8787",
    ...(adminToken ? { adminToken } : {}),
  });
}

function int(v: string | undefined, name: string): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new UsageError(`${name} must be a positive integer`);
  return n;
}

function required<T>(v: T | undefined, name: string): T {
  if (v === undefined || (Array.isArray(v) && v.length === 0)) {
    throw new UsageError(`${name} is required`);
  }
  return v;
}

function relative(iso: string): string {
  const secs = Math.round((Date.parse(iso) - Date.now()) / 1000);
  if (secs <= 0) return "expired";
  return `in ${formatDuration(secs >= 120 ? Math.round(secs / 60) * 60 : secs)}`;
}

function printCheck(res: CheckResult, v: Values): number {
  if (v.json) out(JSON.stringify(res, null, 2));
  else {
    const parts = [
      res.decision.toUpperCase().padEnd(17),
      res.scope ? `[${res.scope}]` : res.reason,
    ];
    if (res.scope && res.decision !== "allow") parts.push(res.reason);
    if (res.remainingUses !== undefined) parts.push(`(${res.remainingUses} uses left)`);
    if (res.approvalId) parts.push(`approval ${res.approvalId}`);
    out(parts.join(" "));
  }
  return res.decision === "allow" ? 0 : res.decision === "deny" ? 3 : 4;
}

function summarize(e: AuditEntry): string {
  const d = e.data as Record<string, unknown>;
  const req = d.request as AccessRequest | undefined;
  switch (e.type) {
    case "check": {
      const target = req ? [req.action, req.resource].filter(Boolean).join(" ") : "";
      return `${String(d.decision).padEnd(17)} ${target}${d.jti ? `  ${d.jti}` : `  (${d.reason})`}`;
    }
    case "grant.created":
      return `${d.grant} -> ${d.agent} for ${d.principal}`;
    case "token.attenuated":
      return `${d.parent} -> ${d.jti} (${d.agent})`;
    case "token.revoked":
    case "grant.revoked":
      return `${d.jti ?? d.grant}, ${(d.cascade as unknown[]).length} token(s) revoked`;
    case "token.attenuation_denied":
      return `${d.parent} tried ${(d.uncovered as string[]).join(", ")}`;
    default:
      return `${d.approvalId ?? ""} ${d.scope ?? ""}`.trim();
  }
}

function printAudit(entries: AuditEntry[]): void {
  for (const e of entries) {
    out(
      `${String(e.seq).padStart(4)}  ${e.ts.slice(11, 19)}  ${e.type.padEnd(24)} ${e.actor.padEnd(18)} ${summarize(e)}`,
    );
  }
}

async function main(argv: string[]): Promise<number> {
  const { values: v, positionals } = parseArgs({
    args: argv,
    options,
    allowPositionals: true,
    strict: true,
  });
  const [cmd, sub, ...rest] = positionals;
  if (v.help || !cmd) {
    out(HELP);
    return v.help ? 0 : 1;
  }

  switch (cmd) {
    case "serve": {
      const adminToken = v["admin-token"] ?? env.AGENT_AUTH_ADMIN_TOKEN;
      if (!adminToken) throw new UsageError("set AGENT_AUTH_ADMIN_TOKEN (at least 16 characters)");
      const issuer = v.issuer ?? env.AGENT_AUTH_ISSUER;
      const srv = await runServer({
        dbPath: v.db ?? env.AGENT_AUTH_DB ?? "./data/agent-auth.db",
        keyPath: v.key ?? env.AGENT_AUTH_KEY ?? "./data/signing-key.pem",
        adminToken,
        port: Number(v.port ?? env.AGENT_AUTH_PORT ?? 8787),
        host: v.host ?? env.AGENT_AUTH_HOST ?? "127.0.0.1",
        ...(issuer ? { issuer } : {}),
      });
      out(`agent-auth listening on ${srv.url} (issuer ${srv.issuer})`);
      const stop = () => {
        void srv.close().then(() => process.exit(0));
      };
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
      return new Promise<number>(() => {});
    }

    case "grant": {
      const res = await client(v).createGrant({
        principal: required(v.principal, "--principal"),
        agent: required(v.agent, "--agent"),
        scopes: required(v.scope, "--scope"),
        ttl: v.ttl ?? "1h",
        ...(v["max-uses"] ? { maxUses: int(v["max-uses"], "--max-uses") as number } : {}),
      });
      if (v.json) out(JSON.stringify(res, null, 2));
      else if (v.quiet) out(res.token);
      else {
        out(`grant    ${res.grant.id}  (${res.grant.principal} -> ${res.grant.agent})`);
        out(`token    ${res.claims.jti}  expires ${relative(res.grant.expiresAt)}`);
        for (const s of res.claims.scp) out(`scope    ${s}`);
        if (res.claims.mxu) out(`max uses ${res.claims.mxu}`);
        out(res.token);
      }
      return 0;
    }

    case "attenuate": {
      const res = await client(v).attenuate({
        token: readToken(v),
        scopes: required(v.scope, "--scope"),
        ...(v.ttl ? { ttl: v.ttl } : {}),
        ...(v["max-uses"] ? { maxUses: int(v["max-uses"], "--max-uses") as number } : {}),
        ...(v.agent ? { agent: v.agent } : {}),
      });
      if (v.json) out(JSON.stringify(res, null, 2));
      else if (v.quiet) out(res.token);
      else {
        out(`token    ${res.claims.jti}  (child of ${res.claims.par}, depth ${res.claims.dep})`);
        out(
          `agent    ${res.claims.sub}  expires ${relative(new Date(res.claims.exp * 1000).toISOString())}`,
        );
        for (const s of res.claims.scp) out(`scope    ${s}`);
        if (res.claims.mxu) out(`max uses ${res.claims.mxu}`);
        out(res.token);
      }
      return 0;
    }

    case "check": {
      const params: Record<string, string | string[]> = {};
      for (const p of v.param ?? []) {
        const i = p.indexOf("=");
        if (i <= 0) throw new UsageError(`--param expects key=value, got "${p}"`);
        const key = p.slice(0, i);
        const val = p.slice(i + 1);
        const prev = params[key];
        params[key] = prev === undefined ? val : [...(Array.isArray(prev) ? prev : [prev]), val];
      }
      const request: AccessRequest = {
        action: required(v.action, "--action"),
        ...(v.resource ? { resource: v.resource } : {}),
        ...(Object.keys(params).length ? { params } : {}),
        ...(v.amount ? { amount: parseAmount(v.amount) } : {}),
      };
      const res = await client(v).check(readToken(v), request, {
        ...(v["dry-run"] ? { dryRun: true } : {}),
        ...(v.approval ? { approvalId: v.approval } : {}),
      });
      return printCheck(res, v);
    }

    case "inspect": {
      const token = readToken(v);
      const claims = decodeToken(token);
      let live: Awaited<ReturnType<AgentAuthClient["introspect"]>> | undefined;
      try {
        live = await client(v).introspect(token);
      } catch (err) {
        if (!(err instanceof AgentAuthError) && !(err instanceof TypeError)) throw err;
      }
      if (v.json) {
        out(JSON.stringify({ claims, live }, null, 2));
        return 0;
      }
      out(`token     ${claims.jti}${claims.par ? `  (child of ${claims.par})` : "  (root)"}`);
      out(`principal ${claims.prn}`);
      out(`agent     ${claims.sub}`);
      out(`grant     ${claims.gnt}`);
      out(`expires   ${new Date(claims.exp * 1000).toISOString()}`);
      for (const s of claims.scp) out(`scope     ${s}`);
      if (claims.mxu) out(`max uses  ${claims.mxu}`);
      if (!live) out("status    unknown (server unreachable)");
      else if (live.active) {
        const self = live.chain?.[live.chain.length - 1];
        out(`status    active${self ? `, ${self.uses} use(s)` : ""}, chain depth ${claims.dep}`);
      } else out(`status    inactive (${live.reason})`);
      return live && !live.active ? 3 : 0;
    }

    case "revoke": {
      const c = client(v);
      let res: { revoked: string[] };
      if (v.grant) res = await c.revokeGrant(v.grant, v.reason);
      else if (sub) res = await c.revokeJti(sub, v.reason);
      else res = await c.revokeToken(readToken(v), v.reason);
      if (v.json) out(JSON.stringify(res, null, 2));
      else
        out(
          `revoked ${res.revoked.length} token(s): ${res.revoked.join(", ") || "(already revoked)"}`,
        );
      return 0;
    }

    case "approvals": {
      const status = (v.status ?? "pending") as "pending";
      const { approvals } = await client(v).listApprovals(status);
      if (v.json) out(JSON.stringify(approvals, null, 2));
      else if (approvals.length === 0) out(`no ${status} approvals`);
      else {
        for (const a of approvals) {
          const r = a.request;
          const amt = r.amount ? ` ${r.amount.value}${r.amount.currency ?? ""}` : "";
          out(
            `${a.id}  ${a.status}  ${r.action}${r.resource ? ` ${r.resource}` : ""}${amt}  [${a.scope}]`,
          );
        }
      }
      return 0;
    }

    case "approve":
    case "deny": {
      const id = required(sub, "approval id");
      const c = client(v);
      const res = cmd === "approve" ? await c.approve(id, v.note) : await c.deny(id, v.note);
      if (v.json) out(JSON.stringify(res, null, 2));
      else out(`${res.id} ${res.status}`);
      return 0;
    }

    case "audit": {
      if (sub === "verify") {
        let entries: Iterable<AuditEntry>;
        let db: ReturnType<typeof openDatabase> | undefined;
        if (v.db) {
          db = openDatabase(v.db, { readonly: true });
          entries = iterateAudit(db);
        } else {
          entries = await client(v).auditAll();
        }
        const res = verifyChain(entries, v.head ? { expectedHead: v.head } : {});
        db?.close();
        if (v.json) out(JSON.stringify(res, null, 2));
        else if (res.ok) out(`OK        ${res.count} entries, chain intact\nhead      ${res.head}`);
        else {
          out(`TAMPERED  ${res.error}`);
          if (res.firstBadSeq !== undefined) out(`first bad entry: seq ${res.firstBadSeq}`);
          out(`verified  ${res.count} entries before the break`);
        }
        return res.ok ? 0 : 1;
      }
      if (sub === "log" || sub === undefined) {
        const after = Number(v.after ?? 0);
        const limit = Number(v.limit ?? 1000);
        let entries: AuditEntry[];
        if (v.db) {
          const db = openDatabase(v.db, { readonly: true });
          entries = listAudit(db, { after, limit });
          db.close();
        } else {
          entries = (await client(v).audit(after, limit)).entries;
        }
        if (v.json) out(JSON.stringify(entries, null, 2));
        else printAudit(entries);
        return 0;
      }
      throw new UsageError(`unknown audit subcommand "${sub}"`);
    }

    default:
      void rest;
      throw new UsageError(`unknown command "${cmd}"`);
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    if (err instanceof UsageError) {
      process.stderr.write(`error: ${err.message}\nRun agent-auth --help for usage.\n`);
    } else if (err instanceof AgentAuthError) {
      process.stderr.write(`error: ${err.code}: ${err.message}\n`);
      const uncovered = (err.body as { error?: { uncovered?: string[] } })?.error?.uncovered;
      if (uncovered)
        for (const u of uncovered) process.stderr.write(`  not covered by parent: ${u}\n`);
    } else if ((err as { code?: string }).code?.startsWith("ERR_PARSE_ARGS")) {
      process.stderr.write(`error: ${(err as Error).message}\nRun agent-auth --help for usage.\n`);
    } else if (err instanceof TypeError && /fetch failed/.test(err.message)) {
      process.stderr.write("error: cannot reach the agent-auth server (check --url)\n");
    } else {
      process.stderr.write(`error: ${(err as Error).message ?? String(err)}\n`);
    }
    process.exitCode = 1;
  },
);
