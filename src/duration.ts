const UNITS: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };

/** Parses `90`, `90s`, `15m`, `1h` or `7d` into whole seconds. */
export function parseDuration(input: string | number): number {
  if (typeof input === "number") {
    if (!Number.isInteger(input) || input <= 0) throw new Error(`invalid duration: ${input}`);
    return input;
  }
  const m = /^(\d+)([smhd]?)$/.exec(input.trim());
  if (!m) throw new Error(`invalid duration: "${input}" (use e.g. 90s, 15m, 1h, 7d)`);
  const seconds = Number(m[1]) * (UNITS[m[2] || "s"] ?? 1);
  if (seconds <= 0) throw new Error(`duration must be positive: "${input}"`);
  return seconds;
}

export function formatDuration(seconds: number): string {
  if (seconds % 86400 === 0) return `${seconds / 86400}d`;
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
}
