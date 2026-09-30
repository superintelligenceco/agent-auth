import { createServer as createHttpServer, type RequestListener } from "node:http";
import type { AddressInfo } from "node:net";
import { getRequestListener } from "@hono/node-server";
import { openDatabase } from "./db.js";
import { loadOrCreateSigningKey } from "./keys.js";
import { createServer } from "./server.js";
import { AgentAuth } from "./service.js";

export interface RunOptions {
  /** SQLite path. Use `:memory:` for an ephemeral server. */
  dbPath: string;
  /** PKCS#8 PEM file for the Ed25519 signing key. Created when missing. */
  keyPath: string;
  adminToken: string;
  /** Port to bind. Use 0 for a random free port. */
  port: number;
  host?: string;
  /** Issuer URL. Defaults to the URL the server listens on. */
  issuer?: string;
  maxTtlSeconds?: number;
  maxDepth?: number;
}

export interface RunningServer {
  url: string;
  issuer: string;
  service: AgentAuth;
  close(): Promise<void>;
}

/** Opens storage, loads the key and starts the HTTP server. */
export async function runServer(opts: RunOptions): Promise<RunningServer> {
  if (!opts.adminToken || opts.adminToken.length < 16) {
    throw new Error("admin token must be at least 16 characters");
  }
  const db = openDatabase(opts.dbPath);
  const key = await loadOrCreateSigningKey(opts.keyPath);
  const host = opts.host ?? "127.0.0.1";

  // The default issuer includes the bound port, which is only known after
  // listening, so requests get 503 until the app is ready.
  let handler: RequestListener = (_req, res) => {
    res.statusCode = 503;
    res.end();
  };
  const server = createHttpServer((req, res) => handler(req, res));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, host, () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  const url = `http://${host.includes(":") ? `[${host}]` : host}:${port}`;
  const issuer = opts.issuer ?? url;
  const service = new AgentAuth({
    db,
    key,
    issuer,
    ...(opts.maxTtlSeconds ? { maxTtlSeconds: opts.maxTtlSeconds } : {}),
    ...(opts.maxDepth ? { maxDepth: opts.maxDepth } : {}),
  });
  handler = getRequestListener(createServer({ service, adminToken: opts.adminToken }).fetch);

  return {
    url,
    issuer,
    service,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          db.close();
          resolve();
        });
        server.closeAllConnections();
      }),
  };
}
