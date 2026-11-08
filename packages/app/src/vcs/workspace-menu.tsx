import { useCallback, useMemo } from "react";
import { withUnistyles } from "react-native-unistyles";
import {
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { mutedIconColorMapping } from "@/components/ui/icon-button-chrome";
import { PluginIconView } from "@/plugins/icons";
import {
  openWorkspaceVcsAction,
  openWorkspaceVcsView,
  useWorkspaceVcsActions,
} from "./workspace-actions";

const ActionIcon = withUnistyles(PluginIconView, mutedIconColorMapping);
export function WorkspaceVcsMenu(props: { serverId: string; workspaceId: string; open: boolean }) {
  const { items, views, error } = useWorkspaceVcsActions(
    props.serverId,
    props.workspaceId,
    props.open,
  );
  if (error) return <DropdownMenuLabel>{error}</DropdownMenuLabel>;
  if (!items.length && !views.length) return null;
  return (
    <>
      <DropdownMenuSeparator />
      <DropdownMenuLabel>{(items[0] ?? views[0])!.section}</DropdownMenuLabel>
      {views.map((item) => (
        <WorkspaceVcsMenuItem key={`view:${item.id}`} {...props} item={item} view />
      ))}
      {items.map((item) => (
        <WorkspaceVcsMenuItem key={item.id} {...props} item={item} />
      ))}
    </>
  );
}
function WorkspaceVcsMenuItem(props: {
  serverId: string;
  workspaceId: string;
  item: ReturnType<typeof useWorkspaceVcsActions>["items"][number];
  view?: boolean;
}) {
  const { serverId, workspaceId, item, view } = props;
  const select = useCallback(
    () =>
      view
        ? openWorkspaceVcsView({
            serverId,
            workspaceId,
            providerId: item.providerId,
            view: item.id,
          })
        : openWorkspaceVcsAction({
            serverId,
            workspaceId,
            providerId: item.providerId,
            actionId: item.id,
          }),
    [serverId, workspaceId, item, view],
  );
  const leading = useMemo(
    () => (item.icon ? <ActionIcon icon={item.icon} size={16} /> : undefined),
    [item.icon],
  );
  return (
    <DropdownMenuItem
      testID={`workspace-vcs-${view ? "view" : "action"}-${item.id}`}
      leading={leading}
      disabled={!item.enabled}
      description={item.reason}
      onSelect={select}
    >
      {item.title}
    </DropdownMenuItem>
  );
}
