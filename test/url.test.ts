import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { trimTrailingSlashes } from "../src/url.js";

describe("trimTrailingSlashes", () => {
  it("removes every trailing slash", () => {
    expect(trimTrailingSlashes("http://localhost:8787///")).toBe("http://localhost:8787");
    expect(trimTrailingSlashes("http://localhost:8787")).toBe("http://localhost:8787");
    expect(trimTrailingSlashes("///")).toBe("");
  });

  it("matches the regular expression it replaces", () => {
    fc.assert(
      fc.property(fc.string({ unit: fc.constantFrom("/", "a", ":", ".") }), (s) => {
        expect(trimTrailingSlashes(s)).toBe(s.replace(/\/+$/, ""));
      }),
      { numRuns: Number(process.env.FC_NUM_RUNS ?? 2000) },
    );
  });

  it("stays linear on long runs of slashes", () => {
    const input = `x${"/".repeat(200_000)}y`;
    const start = performance.now();
    expect(trimTrailingSlashes(input)).toBe(input);
    expect(performance.now() - start).toBeLessThan(100);
  });
});
