import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  type AccessRequest,
  actionMatch,
  actionSubset,
  checkAttenuation,
  evaluate,
  formatScope,
  globMatch,
  globSubset,
  parseScope,
  type Scope,
  scopeMatches,
  scopeSubset,
} from "../../src/scope/index.js";

// The nightly workflow raises FC_NUM_RUNS for a deeper search.
const RUNS = { numRuns: Number(process.env.FC_NUM_RUNS ?? 2000) };

// Small alphabets make collisions (and therefore interesting cases) likely.
const glob = fc
  .array(fc.constantFrom("a", "b", "@", "*"), { maxLength: 5 })
  .map((cs) => cs.join(""));
const plain = fc.array(fc.constantFrom("a", "b", "@"), { maxLength: 5 }).map((cs) => cs.join(""));
const actionPattern = fc
  .array(fc.constantFrom("x", "y", "*"), { minLength: 1, maxLength: 3 })
  .map((s) => s.join(":"));
const concreteAction = fc
  .array(fc.constantFrom("x", "y", "z"), { minLength: 1, maxLength: 4 })
  .map((s) => s.join(":"));
const amount = fc.record(
  {
    value: fc.constantFrom(0, 10, 50, 100),
    currency: fc.constantFrom("USD", "EUR"),
  },
  { requiredKeys: ["value"] },
);

const scope: fc.Arbitrary<Scope> = fc
  .record(
    {
      action: actionPattern,
      resource: glob,
      params: fc.dictionary(fc.constantFrom("to", "cc"), glob, { maxKeys: 2 }),
      max: amount,
      approval: fc.boolean(),
    },
    { requiredKeys: ["action", "params", "approval"] },
  )
  .map((s) => s as Scope);

/** Instantiates a glob into a concrete string that it matches. */
function fillGlob(g: string, fills: string[]): string {
  let i = 0;
  return g.replace(/\*/g, () => fills[i++ % fills.length] ?? "");
}

function fillAction(p: string, segs: string[]): string {
  const parts = p.split(":");
  return parts
    .flatMap((s, i) => {
      if (s !== "*") return [s];
      if (i === parts.length - 1) return segs.length ? segs : ["z"];
      return [segs[0] ?? "z"];
    })
    .join(":");
}

/** A request derived from a scope, so that it often (but not always) matches. */
const requestFor = (s: Scope): fc.Arbitrary<AccessRequest> =>
  fc
    .record({
      fills: fc.array(fc.constantFrom("", "a", "b@", "ab", "@b"), { minLength: 1, maxLength: 3 }),
      segs: fc.array(fc.constantFrom("x", "y", "z"), { maxLength: 2 }),
      amt: fc.option(amount, { nil: undefined }),
      mutate: fc.boolean(),
      extra: plain,
    })
    .map(({ fills, segs, amt, mutate, extra }) => {
      const params: Record<string, string> = {};
      for (const [k, g] of Object.entries(s.params)) params[k] = fillGlob(g, fills);
      const req: AccessRequest = { action: fillAction(s.action, segs), params };
      const r = s.resource !== undefined ? fillGlob(s.resource, fills) : extra;
      req.resource = mutate ? `${r}${extra}` : r;
      const a = amt ?? s.max;
      if (a) req.amount = a;
      return req;
    });

const anyRequest: fc.Arbitrary<AccessRequest> = fc.record(
  {
    action: concreteAction,
    resource: plain,
    params: fc.dictionary(fc.constantFrom("to", "cc"), plain, { maxKeys: 2 }),
    amount,
  },
  { requiredKeys: ["action"] },
);

/** A request that is either random or derived from one of the given scopes. */
const requestAgainst = (scopes: Scope[]): fc.Arbitrary<AccessRequest> =>
  scopes.length === 0
    ? anyRequest
    : fc.oneof(anyRequest, fc.constantFrom(...scopes).chain(requestFor));

/**
 * Derives a scope from `s` by applying random narrowing and widening edits.
 * Roughly half of the results are valid attenuations, which keeps the
 * attenuation properties from discarding most inputs.
 */
const derived = (s: Scope): fc.Arbitrary<Scope> =>
  fc
    .record({
      fills: fc.array(fc.constantFrom("", "a", "b", "*", "a*"), { minLength: 1, maxLength: 2 }),
      segs: fc.array(fc.constantFrom("x", "y", "z", "*"), { maxLength: 2 }),
      action: fc.constantFrom("keep", "fill", "widen"),
      resource: fc.constantFrom("keep", "fill", "widen", "drop"),
      params: fc.constantFrom("keep", "fill", "add", "drop"),
      max: fc.constantFrom("keep", "halve", "double", "drop", "currency"),
      approval: fc.constantFrom("keep", "set", "clear"),
    })
    .map((o) => {
      const c: Scope = { ...s, params: { ...s.params } };
      if (o.action === "fill")
        c.action = fillAction(
          s.action,
          o.segs.filter((x) => x !== "*"),
        );
      if (o.action === "widen") c.action = "*";
      if (o.resource === "fill" && s.resource !== undefined)
        c.resource = fillGlob(s.resource, o.fills);
      if (o.resource === "widen") c.resource = "*";
      if (o.resource === "drop") delete c.resource;
      if (o.params === "fill")
        for (const [k, g] of Object.entries(c.params)) c.params[k] = fillGlob(g, o.fills);
      if (o.params === "add") c.params.cc = "a";
      if (o.params === "drop") c.params = {};
      if (c.max && o.max === "halve") c.max = { ...c.max, value: Math.floor(c.max.value / 2) };
      if (c.max && o.max === "double") c.max = { ...c.max, value: c.max.value * 2 + 1 };
      if (c.max && o.max === "currency")
        c.max = { value: c.max.value, currency: c.max.currency === "USD" ? "EUR" : "USD" };
      if (o.max === "drop") delete c.max;
      if (o.approval === "set") c.approval = true;
      if (o.approval === "clear") c.approval = false;
      return c;
    });

const scopePair = scope.chain((parent) => derived(parent).map((child) => ({ parent, child })));

describe("glob properties", () => {
  it("a pattern matches every instantiation of itself", () => {
    fc.assert(
      fc.property(glob, fc.array(plain, { minLength: 1, maxLength: 3 }), (g, fills) =>
        globMatch(g, fillGlob(g, fills)),
      ),
      RUNS,
    );
  });

  it("globSubset is sound: child matches imply parent matches", () => {
    fc.assert(
      fc.property(
        glob,
        glob,
        fc.array(plain, { minLength: 1, maxLength: 3 }),
        plain,
        (child, parent, fills, v) => {
          fc.pre(globSubset(child, parent));
          for (const value of [fillGlob(child, fills), v]) {
            if (globMatch(child, value)) expect(globMatch(parent, value)).toBe(true);
          }
        },
      ),
      RUNS,
    );
  });

  it("globSubset is reflexive and transitive", () => {
    fc.assert(
      fc.property(glob, glob, glob, (a, b, c) => {
        expect(globSubset(a, a)).toBe(true);
        if (globSubset(a, b) && globSubset(b, c)) expect(globSubset(a, c)).toBe(true);
      }),
      RUNS,
    );
  });
});

describe("action properties", () => {
  it("actionSubset is sound", () => {
    fc.assert(
      fc.property(
        actionPattern,
        actionPattern,
        fc.array(fc.constantFrom("x", "y", "z"), { maxLength: 3 }),
        concreteAction,
        (child, parent, segs, random) => {
          fc.pre(actionSubset(child, parent));
          for (const a of [fillAction(child, segs), random]) {
            if (actionMatch(child, a)) expect(actionMatch(parent, a)).toBe(true);
          }
        },
      ),
      RUNS,
    );
  });

  it("actionSubset is reflexive", () => {
    fc.assert(
      fc.property(actionPattern, (p) => actionSubset(p, p)),
      RUNS,
    );
  });
});

describe("scope properties", () => {
  it("formatScope and parseScope round-trip", () => {
    fc.assert(
      fc.property(scope, (s) => {
        fc.pre(s.resource !== "" && Object.values(s.params).every((g) => g !== ""));
        expect(parseScope(formatScope(s))).toEqual(
          parseScope(formatScope(parseScope(formatScope(s)))),
        );
        expect(formatScope(parseScope(formatScope(s)))).toBe(formatScope(s));
      }),
      RUNS,
    );
  });

  it("scopeSubset is reflexive", () => {
    fc.assert(
      fc.property(scope, (s) => scopeSubset(s, s)),
      RUNS,
    );
  });

  it("a subset scope never permits a request its parent rejects", () => {
    let checked = 0;
    fc.assert(
      fc.property(
        scopePair.chain(({ parent, child }) =>
          fc.tuple(
            fc.constant(parent),
            fc.constant(child),
            fc.array(requestAgainst([child, parent]), { minLength: 1, maxLength: 20 }),
          ),
        ),
        ([parent, child, reqs]) => {
          if (!scopeSubset(child, parent)) return;
          checked++;
          if (parent.approval) expect(child.approval).toBe(true);
          for (const req of reqs) {
            if (scopeMatches(child, req)) expect(scopeMatches(parent, req)).toBe(true);
          }
        },
      ),
      RUNS,
    );
    expect(checked).toBeGreaterThan(RUNS.numRuns / 10);
  });
});

describe("attenuation never widens authority", () => {
  const scopeSet = fc.array(scope, { minLength: 1, maxLength: 4 });

  /** A parent set and a child set derived from it, plus requests to probe both. */
  const family = scopeSet.chain((parent) =>
    fc
      .array(
        fc.constantFrom(...parent).chain((p) => derived(p)),
        { minLength: 1, maxLength: 2 },
      )
      .chain((child) =>
        fc.tuple(
          fc.constant(parent),
          fc.constant(child),
          fc.array(requestAgainst([...child, ...parent]), { minLength: 1, maxLength: 20 }),
        ),
      ),
  );

  function assertNoWidening(child: Scope[], parent: Scope[], reqs: AccessRequest[]) {
    for (const req of reqs) {
      const c = evaluate(child, req);
      const p = evaluate(parent, req);
      if (c.decision !== "deny") expect(p.decision).not.toBe("deny");
      if (c.decision === "allow") expect(p.decision).toBe("allow");
    }
  }

  it("an accepted child set allows nothing the parent set denies", () => {
    let accepted = 0;
    fc.assert(
      fc.property(family, ([parent, child, reqs]) => {
        if (!checkAttenuation(child, parent).ok) return;
        accepted++;
        assertNoWidening(child, parent, reqs);
      }),
      RUNS,
    );
    expect(accepted).toBeGreaterThan(RUNS.numRuns / 40);
  });

  it("holds for unrelated scope sets that happen to pass the check", () => {
    fc.assert(
      fc.property(
        scopeSet,
        scopeSet,
        fc.array(anyRequest, { minLength: 1, maxLength: 10 }),
        (parent, child, reqs) => {
          if (!checkAttenuation(child, parent).ok) return;
          assertNoWidening(child, parent, reqs);
        },
      ),
      RUNS,
    );
  });

  it("a chain of accepted attenuations stays within the root", () => {
    fc.assert(
      fc.property(
        family,
        fc.array(fc.array(scope, { minLength: 1, maxLength: 2 }), { maxLength: 3 }),
        ([root, first, reqs], later) => {
          let current: Scope[] = root;
          for (const next of [first, ...later]) {
            if (checkAttenuation(next, current).ok) current = next;
          }
          for (const req of reqs) {
            if (evaluate(current, req).decision === "allow") {
              expect(evaluate(root, req).decision).toBe("allow");
            }
          }
        },
      ),
      RUNS,
    );
  });
});
