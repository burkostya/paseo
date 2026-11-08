import { useMemo } from "react";
import type { GitAction, GitActions } from "@/git/policy";
import { useSessionStore } from "@/stores/session-store";
import { useHostFeature } from "@/runtime/host-features";
import { openWorkspaceVcsAction } from "./workspace-actions";
// COMPAT(vcsGitActions): v0.15.2; remove legacy Git buttons after their remaining forge/archive surfaces move, target 2027-06-06.
const migrated: Partial<Record<GitAction["id"], string>> = {
  commit: "commit",
  pull: "pull",
  push: "push",
  "pull-and-push": "pull-and-push",
  "merge-from-base": "merge",
};
export const migratedGitActionIds = Object.keys(migrated);
export function useGitVcsActionAdapter(
  serverId: string,
  cwd: string,
  actions: GitActions,
): GitActions {
  const supported = useHostFeature(serverId, "vcsBaseComparisons");
  const workspaceId = useSessionStore((state) => {
    const workspaces = state.sessions[serverId]?.workspaces;
    if (!workspaces) return null;
    for (const workspace of workspaces.values())
      if (workspace.workspaceDirectory === cwd) return workspace.id;
    return null;
  });
  return useMemo(() => {
    if (!supported || !workspaceId) return actions;
    const adapt = (action: GitAction): GitAction => {
      const actionId = migrated[action.id];
      if (!actionId) return action;
      return {
        ...action,
        handler() {
          openWorkspaceVcsAction({ serverId, workspaceId, providerId: "git", actionId });
        },
      };
    };
    return {
      primary: actions.primary ? adapt(actions.primary) : null,
      secondary: actions.secondary.map(adapt),
      menu: actions.menu.map(adapt),
    };
  }, [supported, workspaceId, actions, serverId]);
}
