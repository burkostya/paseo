import { useWorkspace } from "@/stores/session-store-hooks";
import { WorkspaceComparisonDropdown } from "@/git/comparison/menu";
import { PaneContentToolbar } from "@/components/ui/pane-content-toolbar";
import { vcsStyles } from "./styles";
// COMPAT(vcsGitComparisonDefaults): same lifetime as the saved-settings adapter above.
export function GitComparisonSettings({
  serverId,
  workspaceId,
}: {
  serverId: string;
  workspaceId: string;
}) {
  const workspace = useWorkspace(serverId, workspaceId);
  if (workspace?.vcsProviderId !== "git") return null;
  return (
    <PaneContentToolbar style={vcsStyles.toolbar}>
      <WorkspaceComparisonDropdown
        serverId={serverId}
        workspaceId={workspaceId}
        cwd={workspace.workspaceDirectory}
      />
    </PaneContentToolbar>
  );
}
