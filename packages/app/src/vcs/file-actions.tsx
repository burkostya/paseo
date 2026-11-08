import { selectedDiffFiles, type VcsFilePaths } from "./selection";
import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { withUnistyles } from "react-native-unistyles";
import * as Clipboard from "expo-clipboard";
import type { PluginVcsContext } from "@getpaseo/plugin/client";
import { ContextMenuItem, ContextMenuSeparator } from "@/components/ui/context-menu";
import { mutedIconColorMapping } from "@/components/ui/icon-button-chrome";
import { PluginIconView } from "@/plugins/icons";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { useHostFeature } from "@/runtime/host-features";
import { useFileDownload } from "@/hooks/use-file-download";
import { useIsLocalDaemon } from "@/hooks/use-is-local-daemon";
import { openDesktopTarget, useDesktopOpenTargets } from "@/workspace/desktop-open-targets";
import { buildAbsoluteExplorerPath } from "@/utils/explorer-paths";
import { useToast } from "@/contexts/toast-context";
import { useMutation } from "@tanstack/react-query";
import { vcsContextActions } from "./contributions";
import type { ActionTargetProps } from "./data-view";
const ActionIcon = withUnistyles(PluginIconView, mutedIconColorMapping);

export function VcsFileActions(
  props: ActionTargetProps & {
    kind: "file" | "directory";
    path: string;
    files: readonly VcsFilePaths[];
  },
) {
  const context = useMemo(
    () => ({
      ...props.context,
      selectedFiles: selectedDiffFiles(props.files, props.path, props.kind),
    }),
    [props.context, props.files, props.path, props.kind],
  );
  const items = props.resolved
    ? vcsContextActions(props.resolved.contribution.actions, props.context).filter((item) =>
        item.action.fileContexts?.includes(props.kind),
      )
    : [];
  if (!items.length) return null;
  return (
    <>
      {items.map((item) => (
        <FileAction key={item.action.id} {...props} context={context} item={item} />
      ))}
      <ContextMenuSeparator />
    </>
  );
}
function FileAction(
  props: ActionTargetProps & { item: ReturnType<typeof vcsContextActions>[number] },
) {
  const { onAction, item, context } = props;
  const select = useCallback(
    () => onAction(item.action, context),
    [onAction, item.action, context],
  );
  const leading = useMemo(
    () => (item.action.icon ? <ActionIcon icon={item.action.icon} size={16} /> : null),
    [item.action.icon],
  );
  return (
    <ContextMenuItem
      leading={leading}
      onSelect={select}
      description={item.availability.reason}
      disabled={props.disabled || !item.availability.enabled || !context.selectedFiles?.length}
      testID={`vcs-file-action-${item.action.id}`}
    >
      {props.resolved!.plugin.i18n.resolve(item.action.title, props.resolved!.plugin.locale)}
    </ContextMenuItem>
  );
}

export function useVcsFileCommands(input: {
  serverId: string;
  workspaceId: string;
  context: PluginVcsContext;
  disabled: boolean;
}) {
  const { serverId, workspaceId } = input;
  const root = input.context.snapshot.binding.root;
  const client = useHostRuntimeClient(serverId);
  const { t } = useTranslation();
  const toast = useToast();
  const local = useIsLocalDaemon(serverId);
  const { targets } = useDesktopOpenTargets({ isLocalExecution: local });
  const fileManager = targets.find((target) => target.kind === "file-manager");
  const canDuplicate = useHostFeature(serverId, "fsEntryDuplicate");
  const download = useFileDownload({ serverId, workspaceId, workspaceRoot: root });
  const duplicate = useMutation({
    mutationFn: async (path: string) => {
      if (!client) throw new Error(t("vcs.offline"));
      const response = await client.duplicateFileEntry({ cwd: root, path });
      if (!response.success)
        throw new Error(response.error ?? t("workspace.fileExplorer.errors.duplicateFailed"));
    },
    onError: (error) => toast.error(error.message),
  });
  const { mutate: duplicateEntry } = duplicate;
  const copyPath = useCallback(
    (path: string) => {
      void Clipboard.setStringAsync(
        buildAbsoluteExplorerPath({ workspaceRoot: root, entryPath: path }),
      );
    },
    [root],
  );
  const copyRelativePath = useCallback((path: string) => {
    void Clipboard.setStringAsync(path);
  }, []);
  const downloadPath = useCallback(
    (path: string) => download({ fileName: path.split("/").pop() ?? path, path }),
    [download],
  );
  const reveal = useCallback(
    async (path: string) => {
      if (!fileManager) return;
      try {
        await openDesktopTarget({
          editorId: fileManager.id,
          workspacePath: root,
          filePath: buildAbsoluteExplorerPath({ workspaceRoot: root, entryPath: path }),
        });
      } catch (error) {
        toast.error(error instanceof Error ? error.message : String(error));
      }
    },
    [fileManager, root, toast],
  );
  return useMemo(
    () => ({
      workspaceFileDragScope: { serverId, workspaceId },
      onCopyPath: copyPath,
      onCopyRelativePath: copyRelativePath,
      onDownload: downloadPath,
      onDuplicate:
        canDuplicate && !input.disabled && !duplicate.isPending ? duplicateEntry : undefined,
      onReveal: fileManager ? reveal : undefined,
      revealTargetName: fileManager?.label,
    }),
    [
      serverId,
      workspaceId,
      copyPath,
      copyRelativePath,
      downloadPath,
      canDuplicate,
      input.disabled,
      duplicate.isPending,
      duplicateEntry,
      fileManager,
      reveal,
    ],
  );
}
