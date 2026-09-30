import { actionMatch, actionSubset, isConcreteAction } from "./action.js";
import { globMatch, globSubset } from "./glob.js";
import { type Amount, formatAmount, formatScope, parseScope, type Scope } from "./scope.js";

/** A concrete request that an agent wants to perform. */
export interface AccessRequest {
  /** Concrete action, for example `gmail:send`. Wildcards are not allowed. */
  action: string;
  /** Resource the action targets, for example `acme/widgets`. */
  resource?: string;
  /** Named parameters. An array value must satisfy the constraint for every element. */
  params?: Record<string, string | string[]>;
  /** Amount the request spends. */
  amount?: Amount;
}

export type Decision = "allow" | "approval_required" | "deny";

export interface Evaluation {
  decision: Decision;
  /** Canonical form of the scope that produced the decision, when one matched. */
  scope?: string;
  reason: string;
}

type ScopeInput = Scope | string;

function toScope(s: ScopeInput): Scope {
  return typeof s === "string" ? parseScope(s) : s;
}

/**
 * Explains why a scope does not permit a request, or returns `undefined` when
 * it does. The approval flag is ignored.
 */
export function scopeMismatch(scopeInput: ScopeInput, req: AccessRequest): string | undefined {
  const scope = toScope(scopeInput);
  if (!isConcreteAction(req.action)) return "request action must be concrete (no wildcards)";
  if (!actionMatch(scope.action, req.action)) return `action ${req.action} does not match`;
  if (scope.resource !== undefined) {
    if (req.resource === undefined) return "request has no resource";
    if (!globMatch(scope.resource, req.resource)) {
      return `resource ${req.resource} does not match ${scope.resource}`;
    }
  }
  for (const [key, glob] of Object.entries(scope.params)) {
    const raw = req.params?.[key];
    if (raw === undefined) return `request has no ${key} parameter`;
    const values = Array.isArray(raw) ? raw : [raw];
    if (values.length === 0) return `request has no ${key} parameter`;
    const bad = values.find((v) => typeof v !== "string" || !globMatch(glob, v));
    if (bad !== undefined) return `${key} ${String(bad)} does not match ${glob}`;
  }
  if (scope.max) {
    const amt = req.amount;
    if (!amt || !Number.isFinite(amt.value) || amt.value < 0) return "request has no valid amount";
    if ((amt.currency ?? undefined) !== (scope.max.currency ?? undefined)) {
      return `currency ${amt.currency ?? "(none)"} does not match ${scope.max.currency ?? "(none)"}`;
    }
    if (amt.value > scope.max.value) return `amount exceeds max=${formatAmount(scope.max)}`;
  }
  return undefined;
}

/** Returns true when a single scope permits the request, ignoring the approval flag. */
export function scopeMatches(scopeInput: ScopeInput, req: AccessRequest): boolean {
  return scopeMismatch(scopeInput, req) === undefined;
}

/**
 * Evaluates a request against a set of scopes.
 *
 * The request is allowed when any matching scope does not require approval.
 * It needs approval when every matching scope requires approval. Otherwise
 * it is denied.
 */
export function evaluate(scopes: readonly ScopeInput[], req: AccessRequest): Evaluation {
  if (!isConcreteAction(req.action)) {
    return { decision: "deny", reason: "request action must be concrete (no wildcards)" };
  }
  let approvalScope: Scope | undefined;
  let closest: { scope: Scope; why: string } | undefined;
  for (const input of scopes) {
    const scope = toScope(input);
    const why = scopeMismatch(scope, req);
    if (why !== undefined) {
      // Remember the first scope whose action matched, to explain a denial.
      if (!closest && actionMatch(scope.action, req.action)) closest = { scope, why };
      continue;
    }
    if (!scope.approval) {
      return { decision: "allow", scope: formatScope(scope), reason: "matched scope" };
    }
    approvalScope ??= scope;
  }
  if (approvalScope) {
    return {
      decision: "approval_required",
      scope: formatScope(approvalScope),
      reason: "matched scope requires human approval",
    };
  }
  if (closest) {
    return { decision: "deny", reason: `${closest.why} (scope: ${formatScope(closest.scope)})` };
  }
  return { decision: "deny", reason: `no scope covers action ${req.action}` };
}

/** Returns true when every request the child permits is also permitted by the parent. */
export function scopeSubset(childInput: ScopeInput, parentInput: ScopeInput): boolean {
  const child = toScope(childInput);
  const parent = toScope(parentInput);
  if (!actionSubset(child.action, parent.action)) return false;
  if (parent.resource !== undefined) {
    if (child.resource === undefined || !globSubset(child.resource, parent.resource)) return false;
  }
  for (const [key, glob] of Object.entries(parent.params)) {
    const c = child.params[key];
    if (c === undefined || !globSubset(c, glob)) return false;
  }
  if (parent.max) {
    if (!child.max) return false;
    if ((child.max.currency ?? undefined) !== (parent.max.currency ?? undefined)) return false;
    if (child.max.value > parent.max.value) return false;
  }
  if (parent.approval && !child.approval) return false;
  return true;
}

export interface AttenuationCheck {
  ok: boolean;
  /** Child scopes that no parent scope covers. */
  uncovered: string[];
}

/**
 * Checks that a child scope set is no broader than a parent scope set.
 *
 * Every child scope must be covered by a single parent scope. A child scope
 * that is only covered by the union of several parent scopes is rejected.
 */
export function checkAttenuation(
  child: readonly ScopeInput[],
  parent: readonly ScopeInput[],
): AttenuationCheck {
  const parentScopes = parent.map(toScope);
  const uncovered: string[] = [];
  for (const input of child) {
    const c = toScope(input);
    if (!parentScopes.some((p) => scopeSubset(c, p))) uncovered.push(formatScope(c));
  }
  return { ok: uncovered.length === 0, uncovered };
}
