import { createElement, useMemo } from "react";
import { useShallow } from "zustand/shallow";
import { AgentProfileGlyph, resolveAgentProfileIdentity, useAgentProfiles } from "@/agent-profiles";
import { useProviderIcon } from "@/components/provider-icons";
import type { PanelDescriptor, PanelIconProps } from "@/panels/panel-registry";
import { useSessionStore, selectAgentTurnPresentation, type Agent } from "@/stores/session-store";
import { deriveSidebarStateBucket } from "@/utils/sidebar-agent-state";

function formatProviderLabel(provider: Agent["provider"]): string {
  if (!provider) {
    return "Agent";
  }
  return provider
    .split(/[-_\s]+/)
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function resolveAgentLabel(title: string | null | undefined): string | null {
  if (typeof title !== "string") {
    return null;
  }
  const normalized = title.trim();
  if (!normalized) {
    return null;
  }
  if (normalized.toLowerCase() === "new agent") {
    return null;
  }
  return normalized;
}

export function useAgentDescriptor(
  target: { kind: "agent"; agentId: string },
  context: { serverId: string },
): PanelDescriptor {
  const descriptorState = useSessionStore(
    useShallow((state) => {
      const session = state.sessions[context.serverId];
      const agent =
        session?.agents?.get(target.agentId) ?? session?.agentDetails?.get(target.agentId) ?? null;
      return {
        provider: agent?.provider ?? "codex",
        agentProfileId: agent?.agentProfileId,
        title: agent?.title ?? null,
        status: agent?.status ?? null,
        pendingPermissionCount: agent?.pendingPermissions.length ?? 0,
        requiresAttention: agent?.requiresAttention ?? false,
        attentionReason: agent?.attentionReason ?? null,
        isTurnActive: selectAgentTurnPresentation(session, target.agentId).isActive,
      };
    }),
  );
  const providerIcon = useProviderIcon(descriptorState.provider, context.serverId);
  const { profiles } = useAgentProfiles(context.serverId);
  const profile = resolveAgentProfileIdentity(profiles, descriptorState.agentProfileId);
  const profileIcon = profile?.icon;
  const profileColor = profile?.color;
  const hasProfile = profile !== null;
  const icon = useMemo(() => {
    if (!hasProfile) return providerIcon;
    return function AgentProfilePanelIcon({ size }: PanelIconProps) {
      return createElement(AgentProfileGlyph, { icon: profileIcon, color: profileColor, size });
    };
  }, [hasProfile, profileColor, profileIcon, providerIcon]);
  return buildAgentDescriptor({ ...descriptorState, icon, profileName: profile?.name });
}

export function buildAgentDescriptor(input: {
  provider: Agent["provider"];
  title: string | null;
  status: Agent["status"] | null;
  pendingPermissionCount: number;
  requiresAttention: boolean;
  attentionReason: Agent["attentionReason"];
  isTurnActive: boolean;
  icon: PanelDescriptor["icon"];
  profileName?: string;
}): PanelDescriptor {
  const provider = input.provider;
  const label = resolveAgentLabel(input.title);
  const subtitle = `${input.profileName ? `${input.profileName} · ` : ""}${formatProviderLabel(provider)} agent`;
  const tooltip =
    label && input.profileName ? `${label} · ${input.profileName}` : (label ?? subtitle);

  return {
    label: label ?? "",
    subtitle,
    tooltip,
    titleState: label ? "ready" : "loading",
    icon: input.icon,
    statusBucket: input.status
      ? deriveSidebarStateBucket({
          status: input.isTurnActive ? "running" : input.status,
          pendingPermissionCount: input.pendingPermissionCount,
          requiresAttention: input.requiresAttention,
          attentionReason: input.attentionReason,
        })
      : null,
  };
}
