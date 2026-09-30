/**
 * Minimal glob patterns used inside scopes.
 *
 * The only special character is `*`, which matches any sequence of
 * characters, including the empty sequence and `/`. Every other character
 * matches itself. Matching is case-sensitive.
 */

/** Returns true when `value` matches the glob `pattern`. */
export function globMatch(pattern: string, value: string): boolean {
  let p = 0;
  let v = 0;
  let starP = -1;
  let starV = 0;
  while (v < value.length) {
    if (p < pattern.length && pattern[p] !== "*" && pattern[p] === value[v]) {
      p++;
      v++;
    } else if (p < pattern.length && pattern[p] === "*") {
      starP = p;
      starV = v;
      p++;
    } else if (starP !== -1) {
      p = starP + 1;
      starV++;
      v = starV;
    } else {
      return false;
    }
  }
  while (p < pattern.length && pattern[p] === "*") p++;
  return p === pattern.length;
}

/**
 * Returns true when every string matched by `child` is also matched by
 * `parent`.
 *
 * The check is sound: a `true` result guarantees containment. It treats a
 * `*` in the child as an opaque symbol that only a `*` in the parent can
 * absorb, so it can return `false` for a few exotic pairs where containment
 * technically holds. Rejecting those pairs is the safe direction for
 * attenuation.
 */
export function globSubset(child: string, parent: string): boolean {
  const n = parent.length;
  const m = child.length;
  // covers[i][j]: parent[i..] covers child[j..]
  let next = new Array<boolean>(m + 1).fill(false);
  next[m] = true;
  for (let i = n - 1; i >= 0; i--) {
    const cur = new Array<boolean>(m + 1).fill(false);
    const pc = parent[i];
    for (let j = m; j >= 0; j--) {
      if (pc === "*") {
        cur[j] = (next[j] ?? false) || (j < m && (cur[j + 1] ?? false));
      } else {
        const cc = child[j];
        cur[j] = j < m && cc !== "*" && cc === pc && (next[j + 1] ?? false);
      }
    }
    next = cur;
  }
  return next[0] ?? false;
}
