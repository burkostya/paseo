import { describe, expect, it } from "vitest";
import { resolveAgentProfileIdentity } from "./resolve-identity";

const profiles = [
  { id: "review", name: "Review", provider: "codex", icon: "Eye", color: "blue" },
  { id: "ship", name: "Ship", provider: "codex", icon: "Rocket", color: "green" },
];

describe("resolveAgentProfileIdentity", () => {
  it("resolves only the exact profile ID from the host catalog", () => {
    expect(resolveAgentProfileIdentity(profiles, "review")).toEqual({
      id: "review",
      name: "Review",
      icon: "Eye",
      color: "blue",
    });
    expect(resolveAgentProfileIdentity(profiles, "ship")?.name).toBe("Ship");
  });

  it("does not expose an ID while the catalog is loading or after deletion", () => {
    expect(resolveAgentProfileIdentity(null, "review")).toBeNull();
    expect(resolveAgentProfileIdentity(profiles, null)).toBeNull();
    expect(resolveAgentProfileIdentity(profiles, "missing")).toBeNull();
  });

  it("normalizes omitted presentation fields to empty strings", () => {
    expect(
      resolveAgentProfileIdentity([{ id: "plain", name: "Plain", provider: "codex" }], "plain"),
    ).toEqual({ id: "plain", name: "Plain", icon: "", color: "" });
  });
});
