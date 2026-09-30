import { describe, expect, it } from "vitest";
import { type AuditEntry, GENESIS_HASH, hashEntry, verifyChain } from "../src/audit.js";
import { canonicalJson } from "../src/canonical.js";
import { appendAudit, iterateAudit, openDatabase } from "../src/db.js";

function build(n: number): AuditEntry[] {
  const db = openDatabase(":memory:");
  const t = new Date("2026-01-01T00:00:00Z");
  for (let i = 0; i < n; i++) {
    appendAudit(db, "check", `agent:a${i}`, { decision: i % 2 ? "allow" : "deny", n: i }, t);
  }
  const entries = [...iterateAudit(db)];
  db.close();
  return entries;
}

/** Recomputes hashes from `from` onward, as an attacker with write access would. */
function rehash(entries: AuditEntry[], from = 0): AuditEntry[] {
  const out = entries.map((e) => ({ ...e }));
  for (let i = from; i < out.length; i++) {
    const prevHash = i === 0 ? GENESIS_HASH : (out[i - 1] as AuditEntry).hash;
    const e = out[i] as AuditEntry;
    const { hash: _h, ...rest } = { ...e, prevHash };
    out[i] = { ...rest, hash: hashEntry(rest) };
  }
  return out;
}

describe("canonicalJson", () => {
  it("is independent of key order and drops undefined", () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { y: 2, x: 1 }], c: undefined } })).toBe(
      '{"a":{"d":[1,{"x":1,"y":2}]},"b":1}',
    );
    expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }));
    expect(canonicalJson([undefined, Number.NaN])).toBe("[null,null]");
  });
});

describe("verifyChain", () => {
  it("accepts an intact chain", () => {
    const entries = build(5);
    expect(entries[0]?.prevHash).toBe(GENESIS_HASH);
    const res = verifyChain(entries);
    expect(res).toEqual({ ok: true, count: 5, head: entries[4]?.hash });
    expect(verifyChain([])).toEqual({ ok: true, count: 0, head: GENESIS_HASH });
  });

  it("detects an edited entry", () => {
    const entries = build(5);
    const e = entries[2] as AuditEntry;
    entries[2] = { ...e, data: { ...e.data, decision: "allow" } };
    expect(verifyChain(entries)).toMatchObject({ ok: false, firstBadSeq: 3, count: 2 });
  });

  it("detects an edited actor or timestamp", () => {
    for (const patch of [{ actor: "admin" }, { ts: "2026-01-02T00:00:00.000Z" }]) {
      const entries = build(3);
      entries[1] = { ...(entries[1] as AuditEntry), ...patch };
      expect(verifyChain(entries).firstBadSeq).toBe(2);
    }
  });

  it("detects an edit even when the attacker rehashes that entry", () => {
    const entries = build(5);
    const e = entries[1] as AuditEntry;
    const { hash: _h, ...rest } = { ...e, data: { forged: true } };
    entries[1] = { ...rest, hash: hashEntry(rest) };
    // The next entry no longer links to the forged hash.
    expect(verifyChain(entries)).toMatchObject({ ok: false, firstBadSeq: 3 });
  });

  it("detects deleted, reordered and inserted entries", () => {
    const deleted = build(5);
    deleted.splice(2, 1);
    expect(verifyChain(deleted)).toMatchObject({ ok: false, firstBadSeq: 4 });

    const reordered = build(5);
    [reordered[1], reordered[2]] = [reordered[2] as AuditEntry, reordered[1] as AuditEntry];
    expect(verifyChain(reordered).ok).toBe(false);

    const inserted = build(3);
    inserted.splice(1, 0, { ...(inserted[0] as AuditEntry) });
    expect(verifyChain(inserted).ok).toBe(false);
  });

  it("detects truncation and full rewrites only with an anchored head", () => {
    const entries = build(5);
    const anchored = verifyChain(entries).head;
    const truncated = entries.slice(0, 3);
    expect(verifyChain(truncated).ok).toBe(true);
    expect(verifyChain(truncated, { expectedHead: anchored })).toMatchObject({
      ok: false,
      error: expect.stringContaining("truncated"),
    });

    const rewritten = rehash(
      entries.map((e, i) => (i === 1 ? { ...e, data: { forged: true } } : e)),
    );
    expect(verifyChain(rewritten).ok).toBe(true);
    expect(verifyChain(rewritten, { expectedHead: anchored }).ok).toBe(false);
    // An old head that is still part of the chain is accepted.
    expect(verifyChain(entries, { expectedHead: entries[2]?.hash as string }).ok).toBe(true);
  });

  it("verifies a suffix from a checkpoint", () => {
    const entries = build(6);
    const res = verifyChain(entries.slice(3), {
      startSeq: 4,
      startPrevHash: entries[2]?.hash as string,
    });
    expect(res).toMatchObject({ ok: true, count: 3 });
  });
});

describe("audit table", () => {
  it("rejects UPDATE and DELETE", () => {
    const db = openDatabase(":memory:");
    appendAudit(db, "check", "system", { a: 1 }, new Date());
    expect(() => db.prepare("UPDATE audit SET actor = 'x'").run()).toThrow(/append-only/);
    expect(() => db.prepare("DELETE FROM audit").run()).toThrow(/append-only/);
    db.close();
  });

  it("detects tampering by someone who bypasses the triggers", () => {
    const db = openDatabase(":memory:");
    const t = new Date("2026-01-01T00:00:00Z");
    for (let i = 0; i < 4; i++) appendAudit(db, "check", "system", { decision: "deny" }, t);
    expect(verifyChain(iterateAudit(db)).ok).toBe(true);
    db.exec("DROP TRIGGER audit_no_update");
    db.prepare(`UPDATE audit SET data = '{"decision":"allow"}' WHERE seq = 2`).run();
    expect(verifyChain(iterateAudit(db))).toMatchObject({
      ok: false,
      firstBadSeq: 2,
      error: expect.stringContaining("hash mismatch"),
    });
    db.close();
  });
});
