import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { openDatabase } from "../src/db.js";
import { generateSigningKey } from "../src/keys.js";
import { createServer } from "../src/server.js";
import { AgentAuth } from "../src/service.js";

type Spec = {
  openapi: string;
  paths: Record<string, Record<string, unknown>>;
  components: { schemas: Record<string, unknown> };
};

const spec = parse(readFileSync(join(import.meta.dirname, "..", "openapi.yaml"), "utf8")) as Spec;

describe("openapi.yaml", () => {
  it("documents exactly the routes the server exposes", async () => {
    const service = new AgentAuth({
      db: openDatabase(":memory:"),
      key: await generateSigningKey(),
      issuer: "http://x",
    });
    const app = createServer({ service, adminToken: "0123456789abcdef" });
    const served = app.routes
      .filter((r) => r.method !== "ALL")
      .map((r) => `${r.method} ${r.path.replace(/:(\w+)/g, "{$1}")}`);
    const documented = Object.entries(spec.paths).flatMap(([path, ops]) =>
      Object.keys(ops).map((m) => `${m.toUpperCase()} ${path}`),
    );
    expect([...new Set(served)].sort()).toEqual(documented.sort());
  });

  it("resolves every local $ref", () => {
    const text = readFileSync(join(import.meta.dirname, "..", "openapi.yaml"), "utf8");
    const refs = [...text.matchAll(/\$ref: "#\/components\/(\w+)\/(\w+)"/g)];
    expect(refs.length).toBeGreaterThan(10);
    const components = spec.components as unknown as Record<string, Record<string, unknown>>;
    for (const [, kind, name] of refs) {
      expect(components[kind as string]?.[name as string], `${kind}/${name}`).toBeDefined();
    }
  });
});
