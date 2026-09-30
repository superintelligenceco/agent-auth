import { describe, expect, it } from "vitest";
import {
  actionMatch,
  actionSubset,
  checkAttenuation,
  evaluate,
  formatScope,
  globMatch,
  globSubset,
  isConcreteAction,
  isValidActionPattern,
  normalizeScope,
  parseAmount,
  parseScope,
  ScopeParseError,
  scopeMatches,
  scopeMismatch,
  scopeSubset,
} from "../../src/scope/index.js";

describe("globMatch", () => {
  it.each([
    ["*", "", true],
    ["*", "anything/at/all", true],
    ["*@acme.com", "bob@acme.com", true],
    ["*@acme.com", "bob@acme.com.evil.io", false],
    ["*@acme.com", "bob@ACME.com", false],
    ["acme/*", "acme/widgets", true],
    ["acme/*", "acme", false],
    ["a*b*c", "abc", true],
    ["a*b*c", "aXXbYYc", true],
    ["a*b*c", "aXXbYY", false],
    ["exact", "exact", true],
    ["exact", "exact2", false],
    ["", "", true],
    ["", "x", false],
  ])("globMatch(%j, %j) is %s", (pattern, value, expected) => {
    expect(globMatch(pattern, value)).toBe(expected);
  });
});

describe("globSubset", () => {
  it.each([
    ["bob@acme.com", "*@acme.com", true],
    ["*@eng.acme.com", "*@acme.com", false],
    ["*@eng.acme.com", "*acme.com", true],
    ["*@acme.com", "*@eng.acme.com", false],
    ["*", "*@acme.com", false],
    ["*@acme.com", "*", true],
    ["acme/widgets", "acme/*", true],
    ["acme/*", "acme/widgets", false],
    ["a*", "a*", true],
    ["a**", "a*", true],
  ])("globSubset(%j, %j) is %s", (child, parent, expected) => {
    expect(globSubset(child, parent)).toBe(expected);
  });
});

describe("action patterns", () => {
  it("validates segments", () => {
    expect(isValidActionPattern("gmail:send")).toBe(true);
    expect(isValidActionPattern("github:*")).toBe(true);
    expect(isValidActionPattern("GitHub:read")).toBe(false);
    expect(isValidActionPattern("gmail::send")).toBe(false);
    expect(isValidActionPattern("")).toBe(false);
    expect(isValidActionPattern("git*:read")).toBe(false);
    expect(isConcreteAction("gmail:send")).toBe(true);
    expect(isConcreteAction("gmail:*")).toBe(false);
  });

  it.each([
    ["gmail:send", "gmail:send", true],
    ["gmail:send", "gmail:read", false],
    ["gmail:*", "gmail:send", true],
    ["github:*", "github:repo:read", true],
    ["github:*", "github", false],
    ["github:*:read", "github:repo:read", true],
    ["github:*:read", "github:repo:write", false],
    ["github:*:read", "github:a:b:read", false],
    ["*", "anything:at:all", true],
    ["gmail:send", "gmail:send:bulk", false],
  ])("actionMatch(%j, %j) is %s", (pattern, action, expected) => {
    expect(actionMatch(pattern, action)).toBe(expected);
  });

  it.each([
    ["github:repo:read", "github:*", true],
    ["github:*", "github:*", true],
    ["github:*", "github:repo:*", false],
    ["github:repo:*", "github:*", true],
    ["github:*:read", "github:*", true],
    ["github:*", "github:*:read", false],
    ["github:*:read", "github:*:*", true],
    ["github:repo:read", "github:*:read", true],
    ["*", "github:*", false],
    ["gmail:send", "gmail:send", true],
  ])("actionSubset(%j, %j) is %s", (child, parent, expected) => {
    expect(actionSubset(child, parent)).toBe(expected);
  });
});

describe("parseScope", () => {
  it("parses the full grammar", () => {
    expect(parseScope("payments:charge merchant:acme max=50USD approval=required")).toEqual({
      action: "payments:charge",
      params: { merchant: "acme" },
      max: { value: 50, currency: "USD" },
      approval: true,
    });
    expect(parseScope("github:repo:read acme/widgets")).toEqual({
      action: "github:repo:read",
      resource: "acme/widgets",
      params: {},
      approval: false,
    });
    expect(parseScope("  gmail:send   to:*@acme.com ")).toEqual({
      action: "gmail:send",
      params: { to: "*@acme.com" },
      approval: false,
    });
  });

  it("accepts an explicit resource: form", () => {
    expect(parseScope("fs:read resource:a:b").resource).toBe("a:b");
  });

  it.each([
    "",
    "Gmail:send",
    "gmail:send max=fifty",
    "gmail:send max=5usd",
    "gmail:send approval=maybe",
    "gmail:send foo=bar",
    "gmail:send a b",
    "gmail:send to:x to:y",
    "gmail:send max=1 max=2",
    "gmail:send approval=required approval=required",
    "gmail:send max:5",
    "gmail:send approval:x",
    "gmail:send x=",
  ])("rejects %j", (input) => {
    expect(() => parseScope(input)).toThrow(ScopeParseError);
  });

  it("round-trips through formatScope", () => {
    for (const s of [
      "gmail:send to:*@acme.com",
      "github:repo:read acme/widgets",
      "payments:charge max=12.5EUR approval=required",
      "fs:read resource:a:b",
      "fs:write resource:x=y",
      "calendar:* cal:work max=3",
    ]) {
      expect(formatScope(parseScope(s))).toBe(s);
      expect(parseScope(formatScope(parseScope(s)))).toEqual(parseScope(s));
    }
  });

  it("normalizes param order", () => {
    expect(normalizeScope("x:y b:2 a:1")).toBe("x:y a:1 b:2");
  });

  it("parses amounts", () => {
    expect(parseAmount("50USD")).toEqual({ value: 50, currency: "USD" });
    expect(parseAmount("0.25")).toEqual({ value: 0.25 });
    expect(() => parseAmount("-1")).toThrow(ScopeParseError);
  });
});

describe("evaluate", () => {
  const scopes = [
    "gmail:send to:*@acme.com",
    "github:repo:read acme/*",
    "payments:charge max=50USD",
    "payments:refund max=100USD approval=required",
  ];

  it("allows a matching request", () => {
    const e = evaluate(scopes, { action: "gmail:send", params: { to: "bob@acme.com" } });
    expect(e).toEqual({
      decision: "allow",
      scope: "gmail:send to:*@acme.com",
      reason: "matched scope",
    });
  });

  it("requires every array element to match", () => {
    expect(
      evaluate(scopes, { action: "gmail:send", params: { to: ["a@acme.com", "b@acme.com"] } })
        .decision,
    ).toBe("allow");
    expect(
      evaluate(scopes, { action: "gmail:send", params: { to: ["a@acme.com", "eve@evil.io"] } })
        .decision,
    ).toBe("deny");
    expect(evaluate(scopes, { action: "gmail:send", params: { to: [] } }).decision).toBe("deny");
  });

  it("denies a missing param or resource", () => {
    expect(evaluate(scopes, { action: "gmail:send" }).decision).toBe("deny");
    expect(evaluate(scopes, { action: "github:repo:read" }).decision).toBe("deny");
    expect(evaluate(scopes, { action: "github:repo:read", resource: "acme/x" }).decision).toBe(
      "allow",
    );
  });

  it("enforces spend limits and currency", () => {
    const at = (value: number, currency?: string) =>
      evaluate(scopes, {
        action: "payments:charge",
        amount: currency ? { value, currency } : { value },
      }).decision;
    expect(at(50, "USD")).toBe("allow");
    expect(at(50.01, "USD")).toBe("deny");
    expect(at(10, "EUR")).toBe("deny");
    expect(at(10)).toBe("deny");
    expect(at(-1, "USD")).toBe("deny");
    expect(at(Number.NaN, "USD")).toBe("deny");
    expect(evaluate(scopes, { action: "payments:charge" }).decision).toBe("deny");
  });

  it("returns approval_required for approval scopes", () => {
    const e = evaluate(scopes, {
      action: "payments:refund",
      amount: { value: 20, currency: "USD" },
    });
    expect(e.decision).toBe("approval_required");
    expect(e.scope).toBe("payments:refund max=100USD approval=required");
  });

  it("prefers a scope that does not need approval", () => {
    const e = evaluate(["gmail:send approval=required", "gmail:send to:*@acme.com"], {
      action: "gmail:send",
      params: { to: "a@acme.com" },
    });
    expect(e.decision).toBe("allow");
  });

  it("explains denials using the closest scope", () => {
    const reason = (req: Parameters<typeof evaluate>[1]) => evaluate(scopes, req).reason;
    expect(reason({ action: "calendar:read" })).toBe("no scope covers action calendar:read");
    expect(reason({ action: "payments:charge", amount: { value: 80, currency: "USD" } })).toBe(
      "amount exceeds max=50USD (scope: payments:charge max=50USD)",
    );
    expect(reason({ action: "payments:charge", amount: { value: 8, currency: "EUR" } })).toMatch(
      /^currency EUR does not match USD/,
    );
    expect(reason({ action: "payments:charge" })).toMatch(/^request has no valid amount/);
    expect(reason({ action: "github:repo:read", resource: "evil/x" })).toMatch(
      /^resource evil\/x does not match acme\/\*/,
    );
    expect(reason({ action: "github:repo:read" })).toMatch(/^request has no resource/);
    expect(reason({ action: "gmail:send" })).toMatch(/^request has no to parameter/);
    expect(scopeMismatch("x:y", { action: "x:*" })).toMatch(/concrete/);
    expect(scopeMismatch("x:y", { action: "x:y" })).toBeUndefined();
  });

  it("rejects wildcard requests", () => {
    expect(evaluate(["*"], { action: "gmail:*" }).decision).toBe("deny");
    expect(scopeMatches("*", { action: "gmail:*" })).toBe(false);
  });
});

describe("scopeSubset and checkAttenuation", () => {
  it.each([
    ["gmail:send to:bob@acme.com", "gmail:send to:*@acme.com", true],
    ["gmail:send", "gmail:send to:*@acme.com", false],
    ["gmail:send to:*", "gmail:send to:*@acme.com", false],
    ["gmail:send to:a@acme.com cc:x", "gmail:send to:*@acme.com", true],
    ["github:repo:read acme/widgets", "github:* acme/*", true],
    ["github:repo:read", "github:* acme/*", false],
    ["payments:charge max=20USD", "payments:charge max=50USD", true],
    ["payments:charge max=60USD", "payments:charge max=50USD", false],
    ["payments:charge", "payments:charge max=50USD", false],
    ["payments:charge max=20EUR", "payments:charge max=50USD", false],
    ["payments:charge max=20USD", "payments:charge", true],
    ["payments:charge approval=required", "payments:charge", true],
    ["payments:charge", "payments:charge approval=required", false],
  ])("scopeSubset(%j, %j) is %s", (child, parent, expected) => {
    expect(scopeSubset(child, parent)).toBe(expected);
  });

  it("reports uncovered scopes", () => {
    const res = checkAttenuation(
      ["gmail:send to:bob@acme.com", "gmail:delete"],
      ["gmail:send to:*@acme.com"],
    );
    expect(res).toEqual({ ok: false, uncovered: ["gmail:delete"] });
    expect(checkAttenuation(["gmail:send to:a@acme.com"], ["gmail:send to:*@acme.com"]).ok).toBe(
      true,
    );
  });
});
