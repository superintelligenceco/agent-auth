import type { Context, MiddlewareHandler } from "hono";
import {
  type CryptoKey,
  createRemoteJWKSet,
  importJWK,
  type JWK,
  type JWTVerifyGetKey,
} from "jose";
import { ALG } from "./keys.js";
import { type AccessRequest, evaluate } from "./scope/index.js";
import type { CheckResult } from "./service.js";
import { TokenError, verifyToken } from "./tokens.js";
import { trimTrailingSlashes } from "./url.js";

/** Decides whether a presented agent token permits a request. */
export interface Verifier {
  verify(
    token: string,
    request: AccessRequest,
    opts?: { approvalId?: string },
  ): Promise<CheckResult>;
}

/**
 * Verifies against a running agent-auth server. Sees revocations, use limits
 * and approvals immediately, and records every check in the audit log.
 */
export function onlineVerifier(opts: { baseUrl: string; fetch?: typeof fetch }): Verifier {
  const base = trimTrailingSlashes(opts.baseUrl);
  const f = opts.fetch ?? fetch;
  return {
    async verify(token, request, extra) {
      const res = await f(`${base}/v1/check`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          token,
          request,
          ...(extra?.approvalId ? { approvalId: extra.approvalId } : {}),
        }),
      });
      if (!res.ok) {
        return { decision: "deny", reason: `agent-auth server returned HTTP ${res.status}` };
      }
      return (await res.json()) as CheckResult;
    },
  };
}

/**
 * Verifies signature, expiry and scopes locally with the service's public key.
 *
 * Offline verification cannot see revocations, use counts or approvals. It
 * accepts a revoked token until the token expires, so pair it with short TTLs.
 * Scopes that require approval are always denied.
 */
export function offlineVerifier(opts: {
  issuer: string;
  jwksUrl?: string;
  publicJwk?: JWK;
  now?: () => Date;
}): Verifier {
  let keyPromise: Promise<CryptoKey | JWTVerifyGetKey>;
  if (opts.jwksUrl) keyPromise = Promise.resolve(createRemoteJWKSet(new URL(opts.jwksUrl)));
  else if (opts.publicJwk) keyPromise = importJWK(opts.publicJwk, ALG) as Promise<CryptoKey>;
  else throw new Error("offlineVerifier needs jwksUrl or publicJwk");
  return {
    async verify(token, request) {
      try {
        const claims = await verifyToken(token, await keyPromise, {
          issuer: opts.issuer,
          ...(opts.now ? { now: opts.now() } : {}),
        });
        const e = evaluate(claims.scp, request);
        const base = {
          jti: claims.jti,
          agent: claims.sub,
          principal: claims.prn,
          grant: claims.gnt,
        };
        if (e.decision === "approval_required") {
          return {
            ...base,
            decision: "deny",
            reason: "scope requires approval, which offline verification cannot grant",
            ...(e.scope ? { scope: e.scope } : {}),
          };
        }
        return {
          ...base,
          decision: e.decision,
          reason: e.reason,
          ...(e.scope ? { scope: e.scope } : {}),
        };
      } catch (err) {
        if (err instanceof TokenError) return { decision: "deny", reason: err.code };
        throw err;
      }
    },
  };
}

/** Extracts the token from an `Authorization: Bearer <token>` header value. */
export function bearerToken(header: string | null | undefined): string | undefined {
  if (!header) return undefined;
  const m = /^Bearer\s+(\S+)\s*$/i.exec(header);
  return m?.[1];
}

export const APPROVAL_HEADER = "x-agent-auth-approval";

export interface VerifyOptions<C> {
  verifier: Verifier;
  /** Maps an incoming request to the access request that the token must permit. */
  request: (ctx: C) => AccessRequest | Promise<AccessRequest>;
  /** Header that carries the agent token. Defaults to `authorization` with the Bearer scheme. */
  header?: string;
}

function denialBody(result: CheckResult) {
  return {
    error: {
      code: result.decision === "approval_required" ? "approval_required" : "forbidden",
      message: result.reason,
      ...(result.approvalId ? { approvalId: result.approvalId } : {}),
    },
  };
}

function readToken(raw: string | undefined | null, header: string | undefined): string | undefined {
  return header ? raw || undefined : bearerToken(raw);
}

/**
 * Hono middleware that rejects requests whose agent token does not permit the
 * mapped access request. On success, the decision is available as
 * `c.get("agentAuth")`.
 *
 * Responses: 401 without a token, 403 when denied, and 403 with
 * `error.code = "approval_required"` plus `approvalId` when a human must
 * approve. Retry with the `X-Agent-Auth-Approval: <approvalId>` header once
 * approved.
 */
export function verify(opts: VerifyOptions<Context>): MiddlewareHandler {
  return async (c, next) => {
    const token = readToken(c.req.header(opts.header ?? "authorization"), opts.header);
    if (!token) {
      return c.json({ error: { code: "unauthorized", message: "agent token required" } }, 401);
    }
    const approvalId = c.req.header(APPROVAL_HEADER);
    const result = await opts.verifier.verify(
      token,
      await opts.request(c),
      approvalId ? { approvalId } : undefined,
    );
    if (result.decision !== "allow") return c.json(denialBody(result), 403);
    c.set("agentAuth" as never, result as never);
    await next();
  };
}

interface NodeReq {
  headers: Record<string, string | string[] | undefined>;
  agentAuth?: CheckResult;
}
interface NodeRes {
  statusCode: number;
  setHeader(name: string, value: string): unknown;
  end(body?: string): unknown;
}

/**
 * Connect or Express style middleware with the same behavior as {@link verify}.
 * On success, the decision is available as `req.agentAuth`.
 */
export function verifyNode<R extends NodeReq>(opts: VerifyOptions<R>) {
  const send = (res: NodeRes, status: number, body: unknown) => {
    res.statusCode = status;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(body));
  };
  return async (req: R, res: NodeRes, next: (err?: unknown) => void): Promise<void> => {
    try {
      const h = req.headers[opts.header ?? "authorization"];
      const token = readToken(Array.isArray(h) ? h[0] : h, opts.header);
      if (!token) {
        send(res, 401, { error: { code: "unauthorized", message: "agent token required" } });
        return;
      }
      const ap = req.headers[APPROVAL_HEADER];
      const approvalId = Array.isArray(ap) ? ap[0] : ap;
      const result = await opts.verifier.verify(
        token,
        await opts.request(req),
        approvalId ? { approvalId } : undefined,
      );
      if (result.decision !== "allow") {
        send(res, 403, denialBody(result));
        return;
      }
      req.agentAuth = result;
      next();
    } catch (err) {
      next(err);
    }
  };
}
