import type { AgentProfile } from "@getpaseo/protocol/messages";

export interface AgentProfileIdentity {
  id: string;
  name: string;
  icon: string;
  color: string;
}

/** Resolve identity only from the profile catalog belonging to this host. */
export function resolveAgentProfileIdentity(
  profiles: readonly AgentProfile[] | null | undefined,
  profileId: string | null | undefined,
): AgentProfileIdentity | null {
  if (!profileId || !profiles) {
    return null;
  }
  const profile = profiles.find((entry) => entry.id === profileId);
  if (!profile) {
    return null;
  }
  return {
    id: profile.id,
    name: profile.name,
    icon: profile.icon ?? "",
    color: profile.color ?? "",
  };
}
