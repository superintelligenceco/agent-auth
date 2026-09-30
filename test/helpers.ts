import { openDatabase } from "../src/db.js";
import { generateSigningKey } from "../src/keys.js";
import { AgentAuth, type AgentAuthOptions } from "../src/service.js";

export const ISSUER = "https://agent-auth.test";

/** A controllable clock. */
export function fakeClock(start = Date.parse("2026-01-01T00:00:00Z")) {
  let t = start;
  return {
    now: () => new Date(t),
    advance(seconds: number) {
      t += seconds * 1000;
    },
  };
}

/** An in-memory service with a fresh key. */
export async function makeService(opts: Partial<AgentAuthOptions> = {}) {
  const clock = fakeClock();
  const service = new AgentAuth({
    db: openDatabase(":memory:"),
    key: await generateSigningKey("test"),
    issuer: ISSUER,
    now: clock.now,
    ...opts,
  });
  return { service, clock };
}
