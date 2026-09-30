import { describe, expect, it } from "vitest";
import { formatDuration, parseDuration } from "../src/duration.js";

describe("durations", () => {
  it.each([
    ["90", 90],
    ["90s", 90],
    ["15m", 900],
    ["1h", 3600],
    ["7d", 604800],
    [120, 120],
  ])("parseDuration(%j) is %i", (input, seconds) => {
    expect(parseDuration(input)).toBe(seconds);
  });

  it.each(["", "0", "0s", "1w", "-5m", "1.5h", 0, -1, 1.5])("rejects %j", (input) => {
    expect(() => parseDuration(input)).toThrow(/duration/);
  });

  it("formats in the largest whole unit", () => {
    expect(formatDuration(172800)).toBe("2d");
    expect(formatDuration(7200)).toBe("2h");
    expect(formatDuration(300)).toBe("5m");
    expect(formatDuration(61)).toBe("61s");
  });
});
