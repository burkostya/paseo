import type { Href } from "expo-router";
import type { ActiveWorkspaceSelection } from "@/stores/navigation-active-workspace-store";
import type { WorkspaceDescriptor } from "@/stores/session-store";
import { buildWorkspaceArchiveRedirectRoute } from "@/utils/workspace-archive-navigation";

export interface RedirectIfArchivingActiveWorkspaceInput {
  serverId: string;
  workspaceId: string;
  activeWorkspaceSelection: ActiveWorkspaceSelection | null;
}

export interface RedirectIfArchivingActiveWorkspaceDeps {
  navigateToRoute: (route: Href) => void;
  readWorkspaces: (serverId: string) => Iterable<WorkspaceDescriptor>;
}

function isInArchivedWorkspaceSubtree(input: {
  archivedWorkspaceId: string;
  activeWorkspaceId: string;
  workspaces: Iterable<WorkspaceDescriptor>;
}): boolean {
  if (input.archivedWorkspaceId === input.activeWorkspaceId) return true;
  const byId = new Map(Array.from(input.workspaces, (workspace) => [workspace.id, workspace]));
  const visited = new Set<string>();
  let current = byId.get(input.activeWorkspaceId);
  while (current?.parentWorkspaceId) {
    if (visited.has(current.id)) return false;
    visited.add(current.id);
    if (current.parentWorkspaceId === input.archivedWorkspaceId) return true;
    current = byId.get(current.parentWorkspaceId);
  }
  return false;
}

export function redirectIfArchivingActiveWorkspace(
  input: RedirectIfArchivingActiveWorkspaceInput,
  deps: RedirectIfArchivingActiveWorkspaceDeps,
): boolean {
  if (input.activeWorkspaceSelection?.serverId !== input.serverId) {
    return false;
  }

  const workspaces = deps.readWorkspaces(input.serverId);
  if (
    !input.activeWorkspaceSelection ||
    !isInArchivedWorkspaceSubtree({
      archivedWorkspaceId: input.workspaceId,
      activeWorkspaceId: input.activeWorkspaceSelection.workspaceId,
      workspaces,
    })
  ) {
    return false;
  }

  deps.navigateToRoute(
    buildWorkspaceArchiveRedirectRoute({
      serverId: input.serverId,
      archivedWorkspaceId: input.workspaceId,
      workspaces,
    }),
  );
  return true;
}
