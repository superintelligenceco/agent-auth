/**
 * Action patterns are colon-separated segments such as `gmail:send` or
 * `github:repo:read`.
 *
 * - A literal segment matches itself.
 * - A `*` segment in the middle matches exactly one segment.
 * - A `*` segment in the last position matches one or more segments, so
 *   `github:*` matches `github:repo:read`.
 */

export const SEGMENT_RE = /^(?:[a-z0-9][a-z0-9_.-]*|\*)$/;

export function splitAction(action: string): string[] {
  return action.split(":");
}

export function isValidActionPattern(pattern: string): boolean {
  return pattern.length > 0 && splitAction(pattern).every((s) => SEGMENT_RE.test(s));
}

export function isConcreteAction(action: string): boolean {
  return isValidActionPattern(action) && !splitAction(action).includes("*");
}

/** Returns true when the concrete `action` matches `pattern`. */
export function actionMatch(pattern: string, action: string): boolean {
  const p = splitAction(pattern);
  const a = splitAction(action);
  for (let i = 0; i < p.length; i++) {
    const seg = p[i];
    const last = i === p.length - 1;
    if (seg === "*" && last) return a.length >= p.length;
    if (i >= a.length) return false;
    if (seg !== "*" && seg !== a[i]) return false;
  }
  return a.length === p.length;
}

/** Returns true when every action matched by `child` is matched by `parent`. */
export function actionSubset(child: string, parent: string): boolean {
  const c = splitAction(child);
  const p = splitAction(parent);
  for (let i = 0; i < p.length; i++) {
    const ps = p[i];
    const pLast = i === p.length - 1;
    if (ps === "*" && pLast) {
      // Parent accepts any remainder of one or more segments.
      return c.length >= p.length;
    }
    if (i >= c.length) return false;
    const cs = c[i];
    const cLast = i === c.length - 1;
    if (cs === "*" && cLast) {
      // Child accepts an open-ended remainder, parent does not.
      return false;
    }
    if (ps === "*") continue; // any single child segment, literal or `*`
    if (cs !== ps) return false;
  }
  return c.length === p.length;
}
