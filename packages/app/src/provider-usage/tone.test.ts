import { describe, expect, it } from "vitest";
import { deriveTone } from "./tone";

describe("deriveTone", () => {
  it.each([
    [74.9, "default"],
    [75, "warning"],
    [89.9, "warning"],
    [90, "danger"],
    [95, "danger"],
  ] as const)("maps %s percent to %s", (usedPct, expected) => {
    expect(deriveTone(usedPct)).toBe(expected);
  });
});
