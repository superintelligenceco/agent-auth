/**
 * A credential proxy that holds a real upstream API key and injects it only
 * into requests that the presented agent token permits. The agent never sees
 * the key: it sends its agent token, and the proxy swaps it for the secret.
 *
 * In your own project, import from "@superintelligenceco/agent-auth" instead of "../../src/index.js".
 */
import { type Context, Hono } from "hono";
import { type AccessRequest, APPROVAL_HEADER, type Verifier, verify } from "../../src/index.js";

export interface ProxyRule {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** Hono route pattern, for example `/repos/:owner/:repo/issues`. */
  path: string;
  /** Maps the incoming request to the access request the agent token must permit. */
  toRequest: (c: Context) => AccessRequest | Promise<AccessRequest>;
}

export interface ProxyOptions {
  verifier: Verifier;
  /** Base URL of the upstream API, for example `https://api.github.com`. */
  upstream: string;
  /** Credential to inject. Only the proxy process knows `value`. */
  inject: { header: string; value: string };
  /** Allowed routes. Anything else gets 404, so the proxy denies by default. */
  rules: ProxyRule[];
  fetch?: typeof fetch;
}

/** Headers that must not travel from the agent to the upstream API. */
const STRIPPED_REQUEST = new Set([
  "authorization",
  "cookie",
  "host",
  "connection",
  "content-length",
  APPROVAL_HEADER,
]);

const STRIPPED_RESPONSE = new Set(["set-cookie", "connection", "transfer-encoding"]);

export function createCredentialProxy(opts: ProxyOptions): Hono {
  const upstream = opts.upstream.replace(/\/+$/, "");
  const f = opts.fetch ?? fetch;
  const secretHeader = opts.inject.header.toLowerCase();
  const app = new Hono();

  const forward = async (c: Context) => {
    const url = new URL(c.req.url);
    const headers = new Headers();
    for (const [k, v] of Object.entries(c.req.header())) {
      if (!STRIPPED_REQUEST.has(k.toLowerCase()) && k.toLowerCase() !== secretHeader) {
        headers.set(k, v);
      }
    }
    headers.set(opts.inject.header, opts.inject.value);
    const hasBody = !["GET", "HEAD"].includes(c.req.method);
    const res = await f(`${upstream}${url.pathname}${url.search}`, {
      method: c.req.method,
      headers,
      ...(hasBody ? { body: await c.req.arrayBuffer() } : {}),
    });
    const out = new Headers();
    res.headers.forEach((v, k) => {
      if (!STRIPPED_RESPONSE.has(k) && !v.includes(opts.inject.value)) out.set(k, v);
    });
    return new Response(res.body, { status: res.status, headers: out });
  };

  for (const rule of opts.rules) {
    app.on(
      rule.method,
      rule.path,
      verify({ verifier: opts.verifier, request: rule.toRequest }),
      forward,
    );
  }
  app.notFound((c) => c.json({ error: { code: "not_found", message: "route not allowed" } }, 404));
  return app;
}

/** Example rules for a GitHub-style API. */
export const githubRules: ProxyRule[] = [
  {
    method: "GET",
    path: "/repos/:owner/:repo/issues",
    toRequest: (c) => ({
      action: "github:issues:read",
      resource: `${c.req.param("owner")}/${c.req.param("repo")}`,
    }),
  },
  {
    method: "POST",
    path: "/repos/:owner/:repo/issues",
    toRequest: async (c) => {
      const body = (await c.req.json().catch(() => ({}))) as { labels?: unknown };
      const labels = Array.isArray(body.labels) ? body.labels.map(String) : [];
      return {
        action: "github:issues:create",
        resource: `${c.req.param("owner")}/${c.req.param("repo")}`,
        ...(labels.length ? { params: { label: labels } } : {}),
      };
    },
  },
];
