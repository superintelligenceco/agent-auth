import { createHash, timingSafeEqual } from "node:crypto";
import { type Context, Hono, type MiddlewareHandler } from "hono";
import { z } from "zod";
import { parseDuration } from "./duration.js";
import { type AgentAuth, ServiceError } from "./service.js";

export interface ServerOptions {
  service: AgentAuth;
  /** Bearer token required for principal (admin) endpoints. */
  adminToken: string;
}

const ttl = z.union([z.number().int().positive(), z.string().min(1)]).transform((v, ctx) => {
  try {
    return parseDuration(v);
  } catch (err) {
    ctx.addIssue({ code: "custom", message: (err as Error).message });
    return z.NEVER;
  }
});

const amount = z.object({
  value: z.number().finite().nonnegative(),
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .optional(),
});

const accessRequest = z.object({
  action: z.string().min(1).max(200),
  resource: z.string().min(1).max(1000).optional(),
  params: z.record(z.string(), z.union([z.string(), z.array(z.string())])).optional(),
  amount: amount.optional(),
});

const schemas = {
  grant: z.object({
    principal: z.string().min(1),
    agent: z.string().min(1),
    scopes: z.array(z.string().min(1)).min(1).max(100),
    ttl,
    maxUses: z.number().int().positive().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  }),
  attenuate: z.object({
    token: z.string().min(1),
    scopes: z.array(z.string().min(1)).min(1).max(100),
    ttl: ttl.optional(),
    maxUses: z.number().int().positive().optional(),
    agent: z.string().min(1).optional(),
  }),
  token: z.object({ token: z.string().min(1) }),
  revoke: z.object({
    token: z.string().min(1).optional(),
    jti: z.string().min(1).optional(),
    reason: z.string().max(500).optional(),
  }),
  check: z.object({
    token: z.string().min(1),
    request: accessRequest,
    dryRun: z.boolean().optional(),
    approvalId: z.string().min(1).optional(),
  }),
  decision: z.object({ note: z.string().max(500).optional() }).optional(),
  reason: z.object({ reason: z.string().max(500).optional() }).optional(),
};

function digest(s: string): Buffer {
  return createHash("sha256").update(s).digest();
}

async function body<T extends z.ZodType>(c: Context, schema: T): Promise<z.infer<T>> {
  let raw: unknown;
  try {
    const text = await c.req.text();
    raw = text ? JSON.parse(text) : undefined;
  } catch {
    throw new ServiceError("bad_request", "request body must be JSON", 400);
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.length ? `${issue.path.join(".")}: ` : "";
    throw new ServiceError("bad_request", `${where}${issue?.message ?? "invalid body"}`, 400);
  }
  return parsed.data;
}

/** Builds the REST API as a Hono app. Serve it with `@hono/node-server` or any Fetch runtime. */
export function createServer(opts: ServerOptions): Hono {
  const { service } = opts;
  if (!opts.adminToken || opts.adminToken.length < 16) {
    throw new Error("adminToken must be at least 16 characters");
  }
  const adminDigest = digest(opts.adminToken);
  const app = new Hono();

  const requireAdmin: MiddlewareHandler = async (c, next) => {
    const header = c.req.header("authorization") ?? "";
    const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!presented || !timingSafeEqual(digest(presented), adminDigest)) {
      return c.json({ error: { code: "unauthorized", message: "admin token required" } }, 401);
    }
    await next();
  };

  const isAdmin = (c: Context): boolean => {
    const header = c.req.header("authorization") ?? "";
    return header.startsWith("Bearer ") && timingSafeEqual(digest(header.slice(7)), adminDigest);
  };

  app.onError((err, c) => {
    if (err instanceof ServiceError) {
      return c.json(
        { error: { code: err.code, message: err.message, ...(err.details ?? {}) } },
        err.status as 400,
      );
    }
    console.error(err);
    return c.json({ error: { code: "internal", message: "internal error" } }, 500);
  });

  app.notFound((c) => c.json({ error: { code: "not_found", message: "no such route" } }, 404));

  app.get("/healthz", (c) => c.json({ ok: true }));
  app.get("/.well-known/jwks.json", (c) => c.json(service.jwks()));

  app.post("/v1/grants", requireAdmin, async (c) => {
    const b = await body(c, schemas.grant);
    const res = await service.createGrant({
      principal: b.principal,
      agent: b.agent,
      scopes: b.scopes,
      ttlSeconds: b.ttl,
      ...(b.maxUses !== undefined ? { maxUses: b.maxUses } : {}),
      ...(b.metadata ? { metadata: b.metadata } : {}),
    });
    return c.json(res, 201);
  });

  app.get("/v1/grants", requireAdmin, (c) => {
    const principal = c.req.query("principal");
    return c.json({ grants: service.listGrants(principal ? { principal } : {}) });
  });

  app.get("/v1/grants/:id", requireAdmin, (c) => {
    const id = c.req.param("id");
    return c.json({ grant: service.getGrant(id), tokens: service.grantTokens(id) });
  });

  app.post("/v1/grants/:id/revoke", requireAdmin, async (c) => {
    const b = await body(c, schemas.reason);
    return c.json(service.revokeGrant(c.req.param("id"), b?.reason));
  });

  app.post("/v1/tokens/attenuate", async (c) => {
    const b = await body(c, schemas.attenuate);
    const res = await service.attenuate({
      token: b.token,
      scopes: b.scopes,
      ...(b.ttl !== undefined ? { ttlSeconds: b.ttl } : {}),
      ...(b.maxUses !== undefined ? { maxUses: b.maxUses } : {}),
      ...(b.agent !== undefined ? { agent: b.agent } : {}),
    });
    return c.json(res, 201);
  });

  app.post("/v1/tokens/introspect", async (c) => {
    const b = await body(c, schemas.token);
    return c.json(await service.introspect(b.token));
  });

  app.post("/v1/tokens/revoke", async (c) => {
    const b = await body(c, schemas.revoke);
    if (b.jti) {
      if (!isAdmin(c)) {
        return c.json(
          { error: { code: "unauthorized", message: "revoking by jti requires the admin token" } },
          401,
        );
      }
      return c.json(service.revokeToken(b.jti, "admin", b.reason));
    }
    if (b.token) return c.json(await service.revokeSelf(b.token, b.reason));
    throw new ServiceError("bad_request", "provide either token or jti", 400);
  });

  app.post("/v1/check", async (c) => {
    const b = await body(c, schemas.check);
    const res = await service.check({
      token: b.token,
      request: b.request as Parameters<typeof service.check>[0]["request"],
      ...(b.dryRun !== undefined ? { dryRun: b.dryRun } : {}),
      ...(b.approvalId !== undefined ? { approvalId: b.approvalId } : {}),
    });
    return c.json(res);
  });

  app.get("/v1/approvals", requireAdmin, (c) => {
    const status = c.req.query("status");
    const allowed = ["pending", "approved", "denied", "consumed"] as const;
    const s = allowed.find((a) => a === status);
    if (status && !s) throw new ServiceError("bad_request", "invalid status filter", 400);
    return c.json({ approvals: service.listApprovals(s) });
  });

  app.post("/v1/approvals/:id/approve", requireAdmin, async (c) => {
    const b = await body(c, schemas.decision);
    return c.json(service.decideApproval(c.req.param("id"), true, b?.note));
  });

  app.post("/v1/approvals/:id/deny", requireAdmin, async (c) => {
    const b = await body(c, schemas.decision);
    return c.json(service.decideApproval(c.req.param("id"), false, b?.note));
  });

  app.get("/v1/audit", requireAdmin, (c) => {
    const after = Number(c.req.query("after") ?? 0);
    const limit = Math.min(Number(c.req.query("limit") ?? 500), 5000);
    if (!Number.isInteger(after) || after < 0 || !Number.isInteger(limit) || limit <= 0) {
      throw new ServiceError("bad_request", "after and limit must be non-negative integers", 400);
    }
    return c.json({ entries: service.auditEntries({ after, limit }) });
  });

  app.get("/v1/audit/verify", requireAdmin, (c) => {
    const head = c.req.query("head");
    return c.json(service.verifyAudit(head || undefined));
  });

  return app;
}
