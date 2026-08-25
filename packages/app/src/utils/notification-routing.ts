import type { Href } from "expo-router";
import {
  buildHostRootRoute,
  buildHostWorkspaceOpenRoute,
  buildSettingsHostSectionRoute,
} from "@/utils/host-routes";

type NotificationData = Record<string, unknown> | null | undefined;
type NotificationRoute = Extract<Href, string>;

function readNonEmptyString(data: NotificationData, key: string): string | null {
  const value = data?.[key];
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function resolveNotificationTarget(data: NotificationData): {
  serverId: string | null;
  agentId: string | null;
  workspaceId: string | null;
  terminalId: string | null;
  settingsSection: string | null;
} {
  return {
    serverId: readNonEmptyString(data, "serverId"),
    agentId: readNonEmptyString(data, "agentId"),
    workspaceId: readNonEmptyString(data, "workspaceId"),
    terminalId: readNonEmptyString(data, "terminalId"),
    settingsSection: readNonEmptyString(data, "settingsSection"),
  };
}

export function buildNotificationRoute(data: NotificationData): NotificationRoute {
  const { serverId, agentId, workspaceId, terminalId, settingsSection } =
    resolveNotificationTarget(data);
  if (serverId && workspaceId && agentId) {
    return buildHostWorkspaceOpenRoute(serverId, workspaceId, `agent:${agentId}`);
  }
  if (serverId && workspaceId && terminalId) {
    return buildHostWorkspaceOpenRoute(serverId, workspaceId, `terminal:${terminalId}`);
  }
  if (serverId && settingsSection === "usage") {
    return buildSettingsHostSectionRoute(serverId, "usage");
  }
  if (serverId) {
    return buildHostRootRoute(serverId);
  }
  return "/" as const;
}
