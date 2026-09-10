interface AgentProfileCapabilities {
  agentProfiles?: boolean;
  agentConfigApply?: boolean;
  agentProfileIdentity?: boolean;
}

/** The original profile feature: host catalog plus live config application. */
export function supportsAgentProfiles(features: AgentProfileCapabilities | undefined): boolean {
  return features?.agentProfiles === true && features.agentConfigApply === true;
}

/** Whether the host persists and returns the Paseo-owned selected profile ID. */
export function supportsAgentProfileIdentity(
  features: AgentProfileCapabilities | undefined,
): boolean {
  return supportsAgentProfiles(features) && features?.agentProfileIdentity === true;
}
