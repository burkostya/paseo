import type { Agent } from "@/stores/session-store";

export type AgentDirectoryEntry = Pick<
  Agent,
  | "id"
  | "serverId"
  | "title"
  | "status"
  | "lastActivityAt"
  | "cwd"
  | "workspaceId"
  | "provider"
  | "agentProfileId"
  | "requiresAttention"
  | "attentionReason"
  | "attentionTimestamp"
  | "archivedAt"
  | "createdAt"
  | "labels"
  | "projectPlacement"
> & {
  pendingPermissionCount?: number;
};
