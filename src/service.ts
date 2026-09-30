import { createHash, randomBytes } from "node:crypto";
import { type AuditEntry, type AuditVerification, verifyChain } from "./audit.js";
import { canonicalJson } from "./canonical.js";
import { appendAudit, type DB, iterateAudit, listAudit } from "./db.js";
import type { SigningKey } from "./keys.js";
import {
  type AccessRequest,
  checkAttenuation,
  type Decision,
  evaluate,
  normalizeScope,
  ScopeParseError,
} from "./scope/index.js";
import { type AgentTokenClaims, signToken, TokenError, verifyToken } from "./tokens.js";

export type ErrorCode =
  | "bad_request"
  | "invalid_scope"
  | "invalid_token"
  | "expired"
  | "revoked"
  | "scope_escalation"
  | "depth_exceeded"
  | "not_found"
  | "conflict";

export class ServiceError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly status: number,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ServiceError";
  }
}

export interface AgentAuthOptions {
  db: DB;
  key: SigningKey;
  /** Issuer URL placed in `iss`. */
  issuer: string;
  /** Upper bound for any token lifetime, in seconds. Defaults to 30 days. */
  maxTtlSeconds?: number;
  /** Maximum delegation depth. Defaults to 8. */
  maxDepth?: number;
  /** Injectable clock for tests. */
  now?: () => Date;
}

export interface CreateGrantInput {
  principal: string;
  agent: string;
  scopes: string[];
  ttlSeconds: number;
  maxUses?: number;
  metadata?: Record<string, unknown>;
}

export interface Grant {
  id: string;
  principal: string;
  agent: string;
  scopes: string[];
  createdAt: string;
  expiresAt: string;
  maxUses?: number;
  rootJti: string;
  revokedAt?: string;
  metadata: Record<string, unknown>;
}

export interface IssuedToken {
  token: string;
  claims: AgentTokenClaims;
}

export interface AttenuateInput {
  token: string;
  scopes: string[];
  ttlSeconds?: number;
  maxUses?: number;
  agent?: string;
}

export interface CheckInput {
  token: string;
  request: AccessRequest;
  /** When true, evaluates without consuming a use or creating an approval. */
  dryRun?: boolean;
  /** Id of an approved approval for this exact request. */
  approvalId?: string;
}

export interface CheckResult {
  decision: Decision;
  reason: string;
  /** Matched scope in canonical form. */
  scope?: string;
  jti?: string;
  agent?: string;
  principal?: string;
  grant?: string;
  /** Present when `decision` is `approval_required`. */
  approvalId?: string;
  /** Remaining uses on the most constrained token in the chain, when limited. */
  remainingUses?: number;
}

export interface TokenStatus {
  jti: string;
  grant: string;
  parent?: string;
  agent: string;
  scopes: string[];
  depth: number;
  issuedAt: string;
  expiresAt: string;
  maxUses?: number;
  uses: number;
  revokedAt?: string;
}

export interface Introspection {
  active: boolean;
  reason?: string;
  claims?: AgentTokenClaims;
  /** Token chain from the root grant token down to this token. */
  chain?: TokenStatus[];
}

export interface Approval {
  id: string;
  jti: string;
  request: AccessRequest;
  scope: string;
  status: "pending" | "approved" | "denied" | "consumed";
  createdAt: string;
  decidedAt?: string;
  note?: string;
}

interface TokenRow {
  jti: string;
  grant_id: string;
  parent_jti: string | null;
  agent: string;
  scopes: string;
  depth: number;
  issued_at: number;
  expires_at: number;
  max_uses: number | null;
  uses: number;
  revoked_at: number | null;
}

interface GrantRow {
  id: string;
  principal: string;
  agent: string;
  scopes: string;
  created_at: number;
  expires_at: number;
  max_uses: number | null;
  root_jti: string;
  revoked_at: number | null;
  metadata: string;
}

interface ApprovalRow {
  id: string;
  jti: string;
  request: string;
  request_hash: string;
  scope: string;
  status: Approval["status"];
  created_at: number;
  decided_at: number | null;
  note: string | null;
}

const ID_RE = /^[A-Za-z0-9._:@/+-]{1,200}$/;

function newId(prefix: string): string {
  return `${prefix}_${randomBytes(12).toString("base64url")}`;
}

function iso(sec: number): string {
  return new Date(sec * 1000).toISOString();
}

function normalizeAll(scopes: string[]): string[] {
  if (!Array.isArray(scopes) || scopes.length === 0) {
    throw new ServiceError("invalid_scope", "at least one scope is required", 400);
  }
  try {
    return [...new Set(scopes.map(normalizeScope))];
  } catch (err) {
    if (err instanceof ScopeParseError) throw new ServiceError("invalid_scope", err.message, 400);
    throw err;
  }
}

function requestHash(req: AccessRequest): string {
  return createHash("sha256").update(canonicalJson(req)).digest("hex");
}

function toTokenStatus(r: TokenRow): TokenStatus {
  return {
    jti: r.jti,
    grant: r.grant_id,
    ...(r.parent_jti ? { parent: r.parent_jti } : {}),
    agent: r.agent,
    scopes: JSON.parse(r.scopes) as string[],
    depth: r.depth,
    issuedAt: iso(r.issued_at),
    expiresAt: iso(r.expires_at),
    ...(r.max_uses !== null ? { maxUses: r.max_uses } : {}),
    uses: r.uses,
    ...(r.revoked_at !== null ? { revokedAt: iso(r.revoked_at) } : {}),
  };
}

function toGrant(r: GrantRow): Grant {
  return {
    id: r.id,
    principal: r.principal,
    agent: r.agent,
    scopes: JSON.parse(r.scopes) as string[],
    createdAt: iso(r.created_at),
    expiresAt: iso(r.expires_at),
    ...(r.max_uses !== null ? { maxUses: r.max_uses } : {}),
    rootJti: r.root_jti,
    ...(r.revoked_at !== null ? { revokedAt: iso(r.revoked_at) } : {}),
    metadata: JSON.parse(r.metadata) as Record<string, unknown>,
  };
}

function toApproval(r: ApprovalRow): Approval {
  return {
    id: r.id,
    jti: r.jti,
    request: JSON.parse(r.request) as AccessRequest,
    scope: r.scope,
    status: r.status,
    createdAt: iso(r.created_at),
    ...(r.decided_at !== null ? { decidedAt: iso(r.decided_at) } : {}),
    ...(r.note !== null ? { note: r.note } : {}),
  };
}

/** The agent-auth service. The REST server is a thin layer over this class. */
export class AgentAuth {
  readonly db: DB;
  readonly key: SigningKey;
  readonly issuer: string;
  private readonly maxTtl: number;
  private readonly maxDepth: number;
  private readonly clock: () => Date;

  constructor(opts: AgentAuthOptions) {
    this.db = opts.db;
    this.key = opts.key;
    this.issuer = opts.issuer;
    this.maxTtl = opts.maxTtlSeconds ?? 30 * 86400;
    this.maxDepth = opts.maxDepth ?? 8;
    this.clock = opts.now ?? (() => new Date());
  }

  private nowSec(): number {
    return Math.floor(this.clock().getTime() / 1000);
  }

  private audit(
    type: Parameters<typeof appendAudit>[1],
    actor: string,
    data: Record<string, unknown>,
  ) {
    return appendAudit(this.db, type, actor, data, this.clock());
  }

  /** Public keys in JWKS form for offline verification. */
  jwks(): { keys: object[] } {
    return { keys: [this.key.publicJwk] };
  }

  /** Creates a grant and returns it with its root token. */
  async createGrant(input: CreateGrantInput): Promise<{ grant: Grant } & IssuedToken> {
    if (typeof input.principal !== "string" || !ID_RE.test(input.principal)) {
      throw new ServiceError("bad_request", "principal must be a non-empty identifier", 400);
    }
    if (typeof input.agent !== "string" || !ID_RE.test(input.agent)) {
      throw new ServiceError("bad_request", "agent must be a non-empty identifier", 400);
    }
    this.assertTtl(input.ttlSeconds);
    this.assertMaxUses(input.maxUses);
    const scopes = normalizeAll(input.scopes);
    const now = this.nowSec();
    const grantId = newId("gr");
    const claims: AgentTokenClaims = {
      iss: this.issuer,
      sub: input.agent,
      jti: newId("tk"),
      iat: now,
      exp: now + input.ttlSeconds,
      prn: input.principal,
      gnt: grantId,
      scp: scopes,
      dep: 0,
      ...(input.maxUses !== undefined ? { mxu: input.maxUses } : {}),
    };
    const token = await signToken(claims, this.key);
    const metadata = input.metadata ?? {};
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO grants (id, principal, agent, scopes, created_at, expires_at, max_uses, root_jti, metadata)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          grantId,
          input.principal,
          input.agent,
          JSON.stringify(scopes),
          now,
          claims.exp,
          input.maxUses ?? null,
          claims.jti,
          JSON.stringify(metadata),
        );
      this.insertToken(claims, undefined);
      this.audit("grant.created", "admin", {
        grant: grantId,
        jti: claims.jti,
        principal: input.principal,
        agent: input.agent,
        scopes,
        exp: iso(claims.exp),
        maxUses: input.maxUses,
      });
    })();
    return { grant: this.getGrant(grantId), token, claims };
  }

  getGrant(id: string): Grant {
    const row = this.db.prepare("SELECT * FROM grants WHERE id = ?").get(id) as
      | GrantRow
      | undefined;
    if (!row) throw new ServiceError("not_found", `grant ${id} not found`, 404);
    return toGrant(row);
  }

  listGrants(opts: { principal?: string; limit?: number } = {}): Grant[] {
    const rows = (
      opts.principal
        ? this.db
            .prepare("SELECT * FROM grants WHERE principal = ? ORDER BY created_at DESC LIMIT ?")
            .all(opts.principal, opts.limit ?? 100)
        : this.db
            .prepare("SELECT * FROM grants ORDER BY created_at DESC LIMIT ?")
            .all(opts.limit ?? 100)
    ) as GrantRow[];
    return rows.map(toGrant);
  }

  /** All tokens issued under a grant, root first. */
  grantTokens(id: string): TokenStatus[] {
    this.getGrant(id);
    const rows = this.db
      .prepare("SELECT * FROM tokens WHERE grant_id = ? ORDER BY depth ASC, issued_at ASC")
      .all(id) as TokenRow[];
    return rows.map(toTokenStatus);
  }

  private insertToken(claims: AgentTokenClaims, parent: string | undefined) {
    this.db
      .prepare(
        `INSERT INTO tokens (jti, grant_id, parent_jti, agent, scopes, depth, issued_at, expires_at, max_uses)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        claims.jti,
        claims.gnt,
        parent ?? null,
        claims.sub,
        JSON.stringify(claims.scp),
        claims.dep,
        claims.iat,
        claims.exp,
        claims.mxu ?? null,
      );
  }

  private assertTtl(ttl: number | undefined) {
    if (ttl === undefined) return;
    if (!Number.isInteger(ttl) || ttl <= 0) {
      throw new ServiceError(
        "bad_request",
        "ttl must be a positive integer number of seconds",
        400,
      );
    }
    if (ttl > this.maxTtl) {
      throw new ServiceError(
        "bad_request",
        `ttl exceeds the maximum of ${this.maxTtl} seconds`,
        400,
      );
    }
  }

  private assertMaxUses(maxUses: number | undefined) {
    if (maxUses === undefined) return;
    if (!Number.isInteger(maxUses) || maxUses <= 0) {
      throw new ServiceError("bad_request", "maxUses must be a positive integer", 400);
    }
  }

  /** Returns the chain from root to `jti`. */
  private chain(jti: string): TokenRow[] {
    const rows = this.db
      .prepare(
        `WITH RECURSIVE up(jti, parent_jti, lvl) AS (
           SELECT jti, parent_jti, 0 FROM tokens WHERE jti = ?
           UNION ALL
           SELECT t.jti, t.parent_jti, up.lvl + 1 FROM tokens t JOIN up ON t.jti = up.parent_jti
         )
         SELECT tokens.* FROM up JOIN tokens ON tokens.jti = up.jti ORDER BY up.lvl DESC`,
      )
      .all(jti) as TokenRow[];
    return rows;
  }

  /**
   * Verifies a token end to end: signature, expiry, and that neither it nor
   * any ancestor or its grant is revoked.
   */
  private async authenticate(
    token: string,
  ): Promise<{ claims: AgentTokenClaims; chain: TokenRow[] }> {
    let claims: AgentTokenClaims;
    try {
      claims = await verifyToken(token, this.key.publicKey, {
        issuer: this.issuer,
        now: this.clock(),
      });
    } catch (err) {
      if (err instanceof TokenError) {
        throw new ServiceError(err.code, err.message, 401);
      }
      throw err;
    }
    const chain = this.chain(claims.jti);
    if (chain.length === 0) throw new ServiceError("invalid_token", "unknown token", 401);
    const now = this.nowSec();
    for (const t of chain) {
      if (t.revoked_at !== null) {
        throw new ServiceError(
          "revoked",
          t.jti === claims.jti
            ? "token has been revoked"
            : `ancestor token ${t.jti} has been revoked`,
          401,
        );
      }
      if (t.expires_at <= now) throw new ServiceError("expired", `token ${t.jti} has expired`, 401);
    }
    const grant = this.db.prepare("SELECT revoked_at FROM grants WHERE id = ?").get(claims.gnt) as
      | { revoked_at: number | null }
      | undefined;
    if (!grant) throw new ServiceError("invalid_token", "unknown grant", 401);
    if (grant.revoked_at !== null) throw new ServiceError("revoked", "grant has been revoked", 401);
    return { claims, chain };
  }

  /**
   * Derives a narrower token from `input.token`. Rejects any scope that is not
   * covered by the parent, and caps expiry at the parent's expiry.
   */
  async attenuate(input: AttenuateInput): Promise<IssuedToken> {
    const { claims: parent } = await this.authenticate(input.token);
    this.assertTtl(input.ttlSeconds);
    this.assertMaxUses(input.maxUses);
    if (
      input.agent !== undefined &&
      (typeof input.agent !== "string" || !ID_RE.test(input.agent))
    ) {
      throw new ServiceError("bad_request", "agent must be a non-empty identifier", 400);
    }
    const scopes = normalizeAll(input.scopes);
    const actor = `agent:${parent.sub}`;
    const check = checkAttenuation(scopes, parent.scp);
    if (!check.ok) {
      this.audit("token.attenuation_denied", actor, {
        parent: parent.jti,
        requested: scopes,
        uncovered: check.uncovered,
      });
      throw new ServiceError("scope_escalation", "requested scopes exceed the parent token", 403, {
        uncovered: check.uncovered,
      });
    }
    if (parent.dep + 1 > this.maxDepth) {
      throw new ServiceError(
        "depth_exceeded",
        `delegation depth is limited to ${this.maxDepth}`,
        403,
      );
    }
    const now = this.nowSec();
    const exp = Math.min(parent.exp, input.ttlSeconds ? now + input.ttlSeconds : parent.exp);
    let mxu = input.maxUses;
    if (parent.mxu !== undefined) mxu = Math.min(mxu ?? parent.mxu, parent.mxu);
    const claims: AgentTokenClaims = {
      iss: this.issuer,
      sub: input.agent ?? parent.sub,
      jti: newId("tk"),
      iat: now,
      exp,
      prn: parent.prn,
      gnt: parent.gnt,
      scp: scopes,
      par: parent.jti,
      dep: parent.dep + 1,
      ...(mxu !== undefined ? { mxu } : {}),
    };
    const token = await signToken(claims, this.key);
    this.db.transaction(() => {
      this.insertToken(claims, parent.jti);
      this.audit("token.attenuated", actor, {
        grant: claims.gnt,
        parent: parent.jti,
        jti: claims.jti,
        agent: claims.sub,
        scopes,
        exp: iso(exp),
        maxUses: mxu,
      });
    })();
    return { token, claims };
  }

  /** Reports whether a token is active and returns its chain. Never consumes a use. */
  async introspect(token: string): Promise<Introspection> {
    try {
      const { claims, chain } = await this.authenticate(token);
      return { active: true, claims, chain: chain.map(toTokenStatus) };
    } catch (err) {
      if (err instanceof ServiceError) return { active: false, reason: err.code };
      throw err;
    }
  }

  /**
   * Decides whether the token permits `request`. On `allow`, consumes one use
   * on every token in the chain unless `dryRun` is set. Every call is audited.
   */
  async check(input: CheckInput): Promise<CheckResult> {
    const req = input.request;
    if (!req || typeof req.action !== "string") {
      throw new ServiceError("bad_request", "request.action is required", 400);
    }
    const auditReq = {
      action: req.action,
      resource: req.resource,
      params: req.params,
      amount: req.amount,
    };
    let auth: { claims: AgentTokenClaims; chain: TokenRow[] };
    try {
      auth = await this.authenticate(input.token);
    } catch (err) {
      if (!(err instanceof ServiceError)) throw err;
      this.audit("check", "system", {
        decision: "deny",
        reason: err.code,
        request: auditReq,
        dryRun: input.dryRun || undefined,
      });
      return { decision: "deny", reason: err.code };
    }
    const { claims, chain } = auth;
    const actor = `agent:${claims.sub}`;
    const base = { jti: claims.jti, agent: claims.sub, principal: claims.prn, grant: claims.gnt };
    const evaluation = evaluate(claims.scp, req);

    const finish = (result: CheckResult): CheckResult => {
      this.audit("check", actor, {
        ...base,
        decision: result.decision,
        reason: result.reason,
        scope: result.scope,
        request: auditReq,
        approvalId: result.approvalId ?? input.approvalId,
        dryRun: input.dryRun || undefined,
      });
      return result;
    };

    return this.db.transaction((): CheckResult => {
      if (evaluation.decision === "deny") {
        return finish({ ...base, decision: "deny", reason: evaluation.reason });
      }
      const scope = evaluation.scope as string;
      let approvalToConsume: string | undefined;
      if (evaluation.decision === "approval_required") {
        const hash = requestHash(req);
        if (input.approvalId) {
          const row = this.db
            .prepare("SELECT * FROM approvals WHERE id = ?")
            .get(input.approvalId) as ApprovalRow | undefined;
          if (!row || row.jti !== claims.jti || row.request_hash !== hash) {
            return finish({
              ...base,
              decision: "deny",
              reason: "approval does not match this token and request",
              scope,
            });
          }
          if (row.status !== "approved") {
            return finish({
              ...base,
              decision: row.status === "pending" ? "approval_required" : "deny",
              reason: `approval is ${row.status}`,
              scope,
              ...(row.status === "pending" ? { approvalId: row.id } : {}),
            });
          }
          approvalToConsume = row.id;
        } else {
          if (input.dryRun) {
            return finish({
              ...base,
              decision: "approval_required",
              reason: evaluation.reason,
              scope,
            });
          }
          const existing = this.db
            .prepare(
              "SELECT id FROM approvals WHERE jti = ? AND request_hash = ? AND status = 'pending'",
            )
            .get(claims.jti, hash) as { id: string } | undefined;
          const id = existing?.id ?? newId("ap");
          if (!existing) {
            this.db
              .prepare(
                `INSERT INTO approvals (id, jti, request, request_hash, scope, status, created_at)
                 VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
              )
              .run(id, claims.jti, canonicalJson(req), hash, scope, this.nowSec());
            this.audit("approval.requested", actor, {
              ...base,
              approvalId: id,
              scope,
              request: auditReq,
            });
          }
          return finish({
            ...base,
            decision: "approval_required",
            reason: evaluation.reason,
            scope,
            approvalId: id,
          });
        }
      }

      // Enforce use limits across the whole chain.
      let remaining: number | undefined;
      for (const t of chain) {
        if (t.max_uses === null) continue;
        const left = t.max_uses - t.uses;
        if (left <= 0) {
          return finish({
            ...base,
            decision: "deny",
            reason:
              t.jti === claims.jti ? "max_uses_exceeded" : `max_uses_exceeded on ancestor ${t.jti}`,
            scope,
          });
        }
        remaining = remaining === undefined ? left : Math.min(remaining, left);
      }
      if (!input.dryRun) {
        const inc = this.db.prepare("UPDATE tokens SET uses = uses + 1 WHERE jti = ?");
        for (const t of chain) inc.run(t.jti);
        if (remaining !== undefined) remaining -= 1;
        if (approvalToConsume) {
          this.db
            .prepare("UPDATE approvals SET status = 'consumed' WHERE id = ?")
            .run(approvalToConsume);
        }
      }
      return finish({
        ...base,
        decision: "allow",
        reason: approvalToConsume ? "matched scope, approved by a human" : evaluation.reason,
        scope,
        ...(remaining !== undefined ? { remainingUses: remaining } : {}),
      });
    })();
  }

  /**
   * Revokes a token and every token derived from it. Descendants are also
   * rejected implicitly because verification walks the whole chain.
   */
  revokeToken(jti: string, actor = "admin", reason?: string): { revoked: string[] } {
    const exists = this.db.prepare("SELECT jti FROM tokens WHERE jti = ?").get(jti);
    if (!exists) throw new ServiceError("not_found", `token ${jti} not found`, 404);
    const now = this.nowSec();
    return this.db.transaction(() => {
      const rows = this.db
        .prepare(
          `WITH RECURSIVE down(jti) AS (
             SELECT jti FROM tokens WHERE jti = ?
             UNION ALL
             SELECT t.jti FROM tokens t JOIN down ON t.parent_jti = down.jti
           )
           SELECT tokens.jti FROM down JOIN tokens ON tokens.jti = down.jti
           WHERE tokens.revoked_at IS NULL`,
        )
        .all(jti) as { jti: string }[];
      const upd = this.db.prepare("UPDATE tokens SET revoked_at = ? WHERE jti = ?");
      for (const r of rows) upd.run(now, r.jti);
      const revoked = rows.map((r) => r.jti);
      this.audit("token.revoked", actor, { jti, cascade: revoked, reason });
      return { revoked };
    })();
  }

  /** Revokes the token presented by an agent (and its descendants). */
  async revokeSelf(token: string, reason?: string): Promise<{ revoked: string[] }> {
    const { claims } = await this.authenticate(token);
    return this.revokeToken(claims.jti, `agent:${claims.sub}`, reason);
  }

  /** Revokes a grant and every token issued under it. */
  revokeGrant(id: string, reason?: string): { revoked: string[] } {
    const grant = this.getGrant(id);
    const now = this.nowSec();
    return this.db.transaction(() => {
      this.db
        .prepare("UPDATE grants SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?")
        .run(now, id);
      const rows = this.db
        .prepare("SELECT jti FROM tokens WHERE grant_id = ? AND revoked_at IS NULL")
        .all(id) as { jti: string }[];
      const upd = this.db.prepare("UPDATE tokens SET revoked_at = ? WHERE jti = ?");
      for (const r of rows) upd.run(now, r.jti);
      const revoked = rows.map((r) => r.jti);
      this.audit("grant.revoked", "admin", { grant: grant.id, cascade: revoked, reason });
      return { revoked };
    })();
  }

  listApprovals(status?: Approval["status"]): Approval[] {
    const rows = (
      status
        ? this.db
            .prepare("SELECT * FROM approvals WHERE status = ? ORDER BY created_at ASC")
            .all(status)
        : this.db.prepare("SELECT * FROM approvals ORDER BY created_at ASC").all()
    ) as ApprovalRow[];
    return rows.map(toApproval);
  }

  getApproval(id: string): Approval {
    const row = this.db.prepare("SELECT * FROM approvals WHERE id = ?").get(id) as
      | ApprovalRow
      | undefined;
    if (!row) throw new ServiceError("not_found", `approval ${id} not found`, 404);
    return toApproval(row);
  }

  /** Records a human decision on a pending approval. */
  decideApproval(id: string, approve: boolean, note?: string): Approval {
    return this.db.transaction(() => {
      const current = this.getApproval(id);
      if (current.status !== "pending") {
        throw new ServiceError("conflict", `approval is already ${current.status}`, 409);
      }
      this.db
        .prepare("UPDATE approvals SET status = ?, decided_at = ?, note = ? WHERE id = ?")
        .run(approve ? "approved" : "denied", this.nowSec(), note ?? null, id);
      this.audit(approve ? "approval.approved" : "approval.denied", "admin", {
        approvalId: id,
        jti: current.jti,
        scope: current.scope,
        note,
      });
      return this.getApproval(id);
    })();
  }

  auditEntries(opts: { after?: number; limit?: number } = {}): AuditEntry[] {
    return listAudit(this.db, opts);
  }

  verifyAudit(expectedHead?: string): AuditVerification {
    return verifyChain(iterateAudit(this.db), expectedHead ? { expectedHead } : {});
  }
}
