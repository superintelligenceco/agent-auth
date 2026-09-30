import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import type Database from "better-sqlite3";
import { type AuditEntry, type AuditType, GENESIS_HASH, hashEntry } from "./audit.js";

export type DB = Database.Database;

type DatabaseConstructor = new (
  path: string,
  opts?: { readonly?: boolean; fileMustExist?: boolean },
) => DB;

let driver: DatabaseConstructor | undefined;

/**
 * Loads the SQLite driver. Node uses better-sqlite3. The standalone executables
 * run on Bun, which cannot load that native addon, so they use the built-in
 * bun:sqlite module, whose API covers everything this package calls.
 */
function sqlite(): DatabaseConstructor {
  if (!driver) {
    const require = createRequire(import.meta.url);
    driver =
      "Bun" in globalThis
        ? (require("bun:sqlite") as { Database: DatabaseConstructor }).Database
        : (require("better-sqlite3") as DatabaseConstructor);
  }
  return driver;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS grants (
  id TEXT PRIMARY KEY,
  principal TEXT NOT NULL,
  agent TEXT NOT NULL,
  scopes TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  max_uses INTEGER,
  root_jti TEXT NOT NULL,
  revoked_at INTEGER,
  metadata TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS tokens (
  jti TEXT PRIMARY KEY,
  grant_id TEXT NOT NULL REFERENCES grants(id),
  parent_jti TEXT REFERENCES tokens(jti),
  agent TEXT NOT NULL,
  scopes TEXT NOT NULL,
  depth INTEGER NOT NULL,
  issued_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  max_uses INTEGER,
  uses INTEGER NOT NULL DEFAULT 0,
  revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS tokens_parent ON tokens(parent_jti);
CREATE INDEX IF NOT EXISTS tokens_grant ON tokens(grant_id);
CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  jti TEXT NOT NULL REFERENCES tokens(jti),
  request TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  scope TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','approved','denied','consumed')),
  created_at INTEGER NOT NULL,
  decided_at INTEGER,
  note TEXT
);
CREATE INDEX IF NOT EXISTS approvals_lookup ON approvals(jti, request_hash, status);
CREATE TABLE IF NOT EXISTS audit (
  seq INTEGER PRIMARY KEY,
  ts TEXT NOT NULL,
  type TEXT NOT NULL,
  actor TEXT NOT NULL,
  data TEXT NOT NULL,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit
BEGIN SELECT RAISE(ABORT, 'audit log is append-only'); END;
CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit
BEGIN SELECT RAISE(ABORT, 'audit log is append-only'); END;
`;

/**
 * Opens (and migrates) a database. Use `:memory:` for tests. With `readonly`,
 * opens an existing file without changing it, for offline verification.
 */
export function openDatabase(path: string, opts: { readonly?: boolean } = {}): DB {
  if (opts.readonly) {
    if (!existsSync(path)) throw new Error(`database file not found: ${path}`);
    const Database = sqlite();
    return new Database(path, { readonly: true, fileMustExist: true });
  }
  if (path !== ":memory:") {
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const Database = sqlite();
  const db = new Database(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec(SCHEMA);
  if (path !== ":memory:") {
    try {
      chmodSync(path, 0o600);
    } catch {
      // Best effort on file systems without POSIX permissions.
    }
  }
  return db;
}

interface AuditRow {
  seq: number;
  ts: string;
  type: string;
  actor: string;
  data: string;
  prev_hash: string;
  hash: string;
}

function rowToEntry(r: AuditRow): AuditEntry {
  return {
    seq: r.seq,
    ts: r.ts,
    type: r.type as AuditType,
    actor: r.actor,
    data: JSON.parse(r.data) as Record<string, unknown>,
    prevHash: r.prev_hash,
    hash: r.hash,
  };
}

/** Appends an entry to the audit chain. Call inside a transaction for atomicity with the event. */
export function appendAudit(
  db: DB,
  type: AuditType,
  actor: string,
  data: Record<string, unknown>,
  now: Date,
): AuditEntry {
  const last = db.prepare("SELECT seq, hash FROM audit ORDER BY seq DESC LIMIT 1").get() as
    | { seq: number; hash: string }
    | undefined;
  // Round-trip through JSON so the hashed data matches what is stored.
  const clean = JSON.parse(JSON.stringify(data)) as Record<string, unknown>;
  const base = {
    seq: (last?.seq ?? 0) + 1,
    ts: now.toISOString(),
    type,
    actor,
    data: clean,
    prevHash: last?.hash ?? GENESIS_HASH,
  };
  const entry: AuditEntry = { ...base, hash: hashEntry(base) };
  db.prepare(
    "INSERT INTO audit (seq, ts, type, actor, data, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(
    entry.seq,
    entry.ts,
    entry.type,
    entry.actor,
    JSON.stringify(entry.data),
    entry.prevHash,
    entry.hash,
  );
  return entry;
}

export function listAudit(db: DB, opts: { after?: number; limit?: number } = {}): AuditEntry[] {
  const rows = db
    .prepare("SELECT * FROM audit WHERE seq > ? ORDER BY seq ASC LIMIT ?")
    .all(opts.after ?? 0, opts.limit ?? 1000) as AuditRow[];
  return rows.map(rowToEntry);
}

export function* iterateAudit(db: DB): Generator<AuditEntry> {
  for (const r of db.prepare("SELECT * FROM audit ORDER BY seq ASC").iterate()) {
    yield rowToEntry(r as AuditRow);
  }
}
