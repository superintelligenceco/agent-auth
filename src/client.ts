import type { AuditEntry, AuditVerification } from "./audit.js";
import type { AccessRequest } from "./scope/index.js";
import type {
  Approval,
  CheckResult,
  Grant,
  Introspection,
  IssuedToken,
  TokenStatus,
} from "./service.js";

export interface ClientOptions {
  /** Base URL of the agent-auth server, for example `http://localhost:8787`. */
  baseUrl: string;
  /** Admin token, required for principal endpoints. */
  adminToken?: string;
  fetch?: typeof fetch;
}

export class AgentAuthError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = "AgentAuthError";
  }
}

/** Typed HTTP client for the agent-auth REST API. */
export class AgentAuthClient {
  private readonly baseUrl: string;
  private readonly adminToken: string | undefined;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: ClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.adminToken = opts.adminToken;
    this.fetchImpl = opts.fetch ?? fetch;
  }

  private async call<T>(method: string, path: string, body?: unknown, admin = false): Promise<T> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (admin || this.adminToken) {
      if (!this.adminToken && admin) {
        throw new AgentAuthError(0, "unauthorized", "this call requires an admin token");
      }
      if (this.adminToken) headers.authorization = `Bearer ${this.adminToken}`;
    }
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = text;
    }
    if (!res.ok) {
      const err = (json as { error?: { code?: string; message?: string } } | undefined)?.error;
      throw new AgentAuthError(
        res.status,
        err?.code ?? "http_error",
        err?.message ?? `HTTP ${res.status}`,
        json,
      );
    }
    return json as T;
  }

  createGrant(input: {
    principal: string;
    agent: string;
    scopes: string[];
    ttl: string | number;
    maxUses?: number;
    metadata?: Record<string, unknown>;
  }): Promise<{ grant: Grant } & IssuedToken> {
    return this.call("POST", "/v1/grants", input, true);
  }

  listGrants(principal?: string): Promise<{ grants: Grant[] }> {
    const q = principal ? `?principal=${encodeURIComponent(principal)}` : "";
    return this.call("GET", `/v1/grants${q}`, undefined, true);
  }

  getGrant(id: string): Promise<{ grant: Grant; tokens: TokenStatus[] }> {
    return this.call("GET", `/v1/grants/${encodeURIComponent(id)}`, undefined, true);
  }

  revokeGrant(id: string, reason?: string): Promise<{ revoked: string[] }> {
    return this.call("POST", `/v1/grants/${encodeURIComponent(id)}/revoke`, { reason }, true);
  }

  attenuate(input: {
    token: string;
    scopes: string[];
    ttl?: string | number;
    maxUses?: number;
    agent?: string;
  }): Promise<IssuedToken> {
    return this.call("POST", "/v1/tokens/attenuate", input);
  }

  introspect(token: string): Promise<Introspection> {
    return this.call("POST", "/v1/tokens/introspect", { token });
  }

  /** Revokes the presented token and its descendants. */
  revokeToken(token: string, reason?: string): Promise<{ revoked: string[] }> {
    return this.call("POST", "/v1/tokens/revoke", { token, reason });
  }

  /** Revokes a token by id. Requires the admin token. */
  revokeJti(jti: string, reason?: string): Promise<{ revoked: string[] }> {
    return this.call("POST", "/v1/tokens/revoke", { jti, reason }, true);
  }

  check(
    token: string,
    request: AccessRequest,
    opts: { dryRun?: boolean; approvalId?: string } = {},
  ): Promise<CheckResult> {
    return this.call("POST", "/v1/check", { token, request, ...opts });
  }

  listApprovals(status?: Approval["status"]): Promise<{ approvals: Approval[] }> {
    const q = status ? `?status=${status}` : "";
    return this.call("GET", `/v1/approvals${q}`, undefined, true);
  }

  approve(id: string, note?: string): Promise<Approval> {
    return this.call("POST", `/v1/approvals/${encodeURIComponent(id)}/approve`, { note }, true);
  }

  deny(id: string, note?: string): Promise<Approval> {
    return this.call("POST", `/v1/approvals/${encodeURIComponent(id)}/deny`, { note }, true);
  }

  audit(after = 0, limit = 500): Promise<{ entries: AuditEntry[] }> {
    return this.call("GET", `/v1/audit?after=${after}&limit=${limit}`, undefined, true);
  }

  /** Downloads the whole audit log page by page. */
  async auditAll(): Promise<AuditEntry[]> {
    const all: AuditEntry[] = [];
    let after = 0;
    for (;;) {
      const { entries } = await this.audit(after, 1000);
      all.push(...entries);
      const last = entries[entries.length - 1];
      if (!last || entries.length < 1000) return all;
      after = last.seq;
    }
  }

  /** Asks the server to verify its own chain. Prefer {@link auditAll} plus local verification. */
  serverVerifyAudit(head?: string): Promise<AuditVerification> {
    const q = head ? `?head=${encodeURIComponent(head)}` : "";
    return this.call("GET", `/v1/audit/verify${q}`, undefined, true);
  }

  jwks(): Promise<{ keys: object[] }> {
    return this.call("GET", "/.well-known/jwks.json");
  }
}
