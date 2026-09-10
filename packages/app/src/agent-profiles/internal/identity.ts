import { useMemo } from "react";
import { useAgentProfiles } from "./use-agent-profiles";
import { resolveAgentProfileIdentity, type AgentProfileIdentity } from "./resolve-identity";

export { resolveAgentProfileIdentity, type AgentProfileIdentity } from "./resolve-identity";

/** Shared hook for surfaces that need to render a selected profile identity. */
export function useAgentProfileIdentity(
  serverId: string | null,
  profileId: string | null | undefined,
): AgentProfileIdentity | null {
  const { profiles } = useAgentProfiles(serverId);
  return useMemo(() => resolveAgentProfileIdentity(profiles, profileId), [profileId, profiles]);
}
