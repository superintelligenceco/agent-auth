import { createHash } from "node:crypto";
import { canonicalJson } from "./canonical.js";

export const GENESIS_HASH = "0".repeat(64);

export type AuditType =
  | "grant.created"
  | "grant.revoked"
  | "token.attenuated"
  | "token.attenuation_denied"
  | "token.revoked"
  | "check"
  | "approval.requested"
  | "approval.approved"
  | "approval.denied";

/** One entry in the hash-chained audit log. */
export interface AuditEntry {
  seq: number;
  /** ISO 8601 timestamp. */
  ts: string;
  type: AuditType;
  /** Who caused the event: `admin`, `agent:<id>` or `system`. */
  actor: string;
  data: Record<string, unknown>;
  /** Hash of the previous entry, or {@link GENESIS_HASH} for the first entry. */
  prevHash: string;
  /** `sha256(prevHash + "\n" + canonicalJson({seq, ts, type, actor, data}))`, hex encoded. */
  hash: string;
}

export function hashEntry(entry: Omit<AuditEntry, "hash">): string {
  const body = canonicalJson({
    seq: entry.seq,
    ts: entry.ts,
    type: entry.type,
    actor: entry.actor,
    data: entry.data,
  });
  return createHash("sha256").update(`${entry.prevHash}\n${body}`).digest("hex");
}

export interface AuditVerification {
  ok: boolean;
  /** Number of entries checked. */
  count: number;
  /** Hash of the last valid entry. Anchor this value outside the service to detect truncation. */
  head: string;
  /** Sequence number of the first entry that fails verification. */
  firstBadSeq?: number;
  error?: string;
}

/**
 * Verifies a sequence of audit entries in order.
 *
 * Detects edited, reordered, inserted and deleted entries. On its own it cannot
 * detect removal of entries from the end of the log; compare `head` with a
 * previously recorded head (`expectedHead`) to catch that.
 */
export function verifyChain(
  entries: Iterable<AuditEntry>,
  opts: { expectedHead?: string; startSeq?: number; startPrevHash?: string } = {},
): AuditVerification {
  let prev = opts.startPrevHash ?? GENESIS_HASH;
  let expectedSeq = opts.startSeq ?? 1;
  let count = 0;
  let sawExpectedHead = opts.expectedHead === undefined || opts.expectedHead === prev;
  for (const e of entries) {
    const fail = (error: string): AuditVerification => ({
      ok: false,
      count,
      head: prev,
      firstBadSeq: e.seq,
      error,
    });
    if (e.seq !== expectedSeq) return fail(`expected seq ${expectedSeq}, found ${e.seq}`);
    if (e.prevHash !== prev) return fail(`entry ${e.seq} does not link to the previous hash`);
    const { hash, ...rest } = e;
    if (hashEntry(rest) !== hash) return fail(`entry ${e.seq} hash mismatch (content altered)`);
    prev = hash;
    expectedSeq++;
    count++;
    if (hash === opts.expectedHead) sawExpectedHead = true;
  }
  if (!sawExpectedHead) {
    return {
      ok: false,
      count,
      head: prev,
      error: "expected head not found; the log was truncated or rewritten",
    };
  }
  return { ok: true, count, head: prev };
}
