import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadOrCreateSigningKey } from "../src/keys.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function keyPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "agent-auth-keys-"));
  dirs.push(dir);
  return join(dir, "nested", "signing-key.pem");
}

describe("loadOrCreateSigningKey", () => {
  it("creates the key with mode 0600 and loads the same key on restart", async () => {
    const path = keyPath();
    const first = await loadOrCreateSigningKey(path);
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
    const second = await loadOrCreateSigningKey(path);
    expect(second.kid).toBe(first.kid);
    expect(second.publicJwk).toEqual(first.publicJwk);
  });

  it("converges on one key when two callers race to create it", async () => {
    const path = keyPath();
    const keys = await Promise.all(Array.from({ length: 8 }, () => loadOrCreateSigningKey(path)));
    const onDisk = /^# kid: (\S+)$/m.exec(readFileSync(path, "utf8"))?.[1];
    for (const k of keys) expect(k.kid).toBe(onDisk);
  });
});
