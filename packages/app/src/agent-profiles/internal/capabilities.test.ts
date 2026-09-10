import { describe, expect, it } from "vitest";
import { supportsAgentProfileIdentity, supportsAgentProfiles } from "./capabilities";

describe("agent profile capabilities", () => {
  it("keeps profile application compatible with older hosts", () => {
    expect(supportsAgentProfiles(undefined)).toBe(false);
    expect(supportsAgentProfiles({ agentProfiles: true })).toBe(false);
    expect(supportsAgentProfiles({ agentConfigApply: true })).toBe(false);
    expect(supportsAgentProfiles({ agentProfiles: true, agentConfigApply: true })).toBe(true);
  });

  it("gates selected profile identity separately", () => {
    expect(supportsAgentProfileIdentity({ agentProfiles: true, agentConfigApply: true })).toBe(
      false,
    );
    expect(
      supportsAgentProfileIdentity({
        agentProfiles: true,
        agentConfigApply: true,
        agentProfileIdentity: true,
      }),
    ).toBe(true);
  });
});
