import { isValidActionPattern } from "./action.js";

/**
 * A parsed scope.
 *
 * Text form: `<action> [<resource-glob>] [<key>:<glob> ...] [max=<n>[CUR]] [approval=required]`
 *
 * Examples:
 * - `gmail:send to:*@acme.com`
 * - `github:repo:read acme/widgets`
 * - `payments:charge max=50USD approval=required`
 */
export interface Scope {
  /** Action pattern, for example `github:repo:*`. */
  action: string;
  /** Glob that the request resource must match. Absent means any resource. */
  resource?: string;
  /** Globs that named request parameters must match. */
  params: Record<string, string>;
  /** Per-request amount ceiling. */
  max?: Amount;
  /** When true, a human must approve each use of this scope. */
  approval: boolean;
}

export interface Amount {
  value: number;
  /** Upper-case ISO 4217 style code, for example `USD`. Absent means unitless. */
  currency?: string;
}

export class ScopeParseError extends Error {
  constructor(
    message: string,
    readonly input: string,
  ) {
    super(`${message}: "${input}"`);
    this.name = "ScopeParseError";
  }
}

const KEY_RE = /^[a-z_][a-z0-9_]*$/;
const PARAM_RE = /^([a-z_][a-z0-9_]*):(\S+)$/;
const SETTING_RE = /^([a-z_][a-z0-9_]*)=(\S+)$/;
const AMOUNT_RE = /^(\d{1,15}(?:\.\d{1,6})?)([A-Z]{3})?$/;
/** Param names that are reserved because they have their own syntax. */
const RESERVED = new Set(["resource", "max", "approval"]);

export function parseAmount(text: string): Amount {
  const m = AMOUNT_RE.exec(text);
  if (!m) throw new ScopeParseError("invalid amount, expected e.g. 50USD or 12.5", text);
  const value = Number(m[1]);
  return m[2] ? { value, currency: m[2] } : { value };
}

export function formatAmount(amount: Amount): string {
  return `${amount.value}${amount.currency ?? ""}`;
}

/** Parses one scope string. Throws {@link ScopeParseError} on invalid input. */
export function parseScope(input: string): Scope {
  const tokens = input.trim().split(/\s+/).filter(Boolean);
  const [action, ...rest] = tokens;
  if (!action || !isValidActionPattern(action)) {
    throw new ScopeParseError("invalid action pattern", input);
  }
  const scope: Scope = { action, params: {}, approval: false };
  for (const tok of rest) {
    const setting = SETTING_RE.exec(tok);
    if (setting) {
      const [, key, value] = setting as unknown as [string, string, string];
      if (key === "max") {
        if (scope.max) throw new ScopeParseError("duplicate max", input);
        scope.max = parseAmount(value);
      } else if (key === "approval") {
        if (value !== "required") {
          throw new ScopeParseError("approval only accepts the value 'required'", input);
        }
        if (scope.approval) throw new ScopeParseError("duplicate approval", input);
        scope.approval = true;
      } else {
        throw new ScopeParseError(`unknown setting '${key}'`, input);
      }
      continue;
    }
    const param = PARAM_RE.exec(tok);
    if (param) {
      const [, key, glob] = param as unknown as [string, string, string];
      if (RESERVED.has(key) && key !== "resource") {
        throw new ScopeParseError(`'${key}' is reserved`, input);
      }
      if (key === "resource") {
        if (scope.resource !== undefined) throw new ScopeParseError("duplicate resource", input);
        scope.resource = glob;
        continue;
      }
      if (key in scope.params) throw new ScopeParseError(`duplicate param '${key}'`, input);
      scope.params[key] = glob;
      continue;
    }
    if (tok.includes("=")) throw new ScopeParseError(`malformed setting '${tok}'`, input);
    if (scope.resource !== undefined) throw new ScopeParseError("duplicate resource", input);
    scope.resource = tok;
  }
  return scope;
}

/** Formats a scope in canonical text form. `parseScope(formatScope(s))` equals `s`. */
export function formatScope(scope: Scope): string {
  const parts = [scope.action];
  if (scope.resource !== undefined) {
    const r = scope.resource;
    // A resource that looks like `key:value` or `key=value` needs the explicit form.
    parts.push(PARAM_RE.test(r) || r.includes("=") ? `resource:${r}` : r);
  }
  for (const key of Object.keys(scope.params).sort()) {
    parts.push(`${key}:${scope.params[key]}`);
  }
  if (scope.max) parts.push(`max=${formatAmount(scope.max)}`);
  if (scope.approval) parts.push("approval=required");
  return parts.join(" ");
}

/** Parses a list of scope strings. */
export function parseScopes(inputs: readonly string[]): Scope[] {
  return inputs.map(parseScope);
}

/** Returns the canonical form of a scope string. */
export function normalizeScope(input: string): string {
  return formatScope(parseScope(input));
}

export function isValidParamKey(key: string): boolean {
  return KEY_RE.test(key) && !RESERVED.has(key);
}
