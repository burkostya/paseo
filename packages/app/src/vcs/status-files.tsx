import { FlatList } from "@/components/ui/scroll-view";
import { TreeChevron, treeRowPaddingLeft } from "@/components/tree-primitives";
import type { ChangesState } from "@/panels/changes/state";
import { statusTreeRows, type StatusTreeRow } from "./status-tree";
import { useCallback, useMemo } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import type { VcsSnapshot } from "@getpaseo/protocol/vcs";
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
} from "@/components/ui/context-menu";
import { VcsFileActions } from "./file-actions";
import type { ActionTargetProps } from "./data-view";
import { vcsStyles as styles } from "./styles";

interface Props extends ActionTargetProps {
  openFile(path: string): void;
  state: ChangesState;
  setState(state: ChangesState): void;
}
export function VcsStatusFiles(props: Props) {
  const { t } = useTranslation();
  const { state, setState } = props;
  const rows = useMemo(
    () => statusTreeRows(props.context.snapshot.files, state.collapsedFolderPaths),
    [props.context.snapshot.files, state.collapsedFolderPaths],
  );
  const toggleFolder = useCallback(
    (path: string) => {
      const collapsed = new Set(state.collapsedFolderPaths);
      if (collapsed.has(path)) collapsed.delete(path);
      else collapsed.add(path);
      setState({ ...state, collapsedFolderPaths: [...collapsed] });
    },
    [state, setState],
  );
  const renderItem = useCallback(
    ({ item }: { item: StatusTreeRow }) =>
      item.kind === "directory" ? (
        <StatusDirectory {...props} row={item} toggleFolder={toggleFolder} />
      ) : (
        <StatusFile {...props} file={item.file} depth={item.depth} name={item.name} />
      ),
    [props, toggleFolder],
  );
  return (
    <View style={styles.container} testID="vcs-status-files">
      <Text style={styles.empty}>{t("vcs.diffUnavailable")}</Text>
      {props.context.selection.kind === "workspace" ? (
        <>
          <Text style={styles.selection}>{t("vcs.workingCopy")}</Text>
          <FlatList
            data={rows}
            keyExtractor={fileKey}
            renderItem={renderItem}
            ListEmptyComponent={EmptyStatus}
          />
        </>
      ) : null}
    </View>
  );
}
function StatusFile(
  props: Props & { file: VcsSnapshot["files"][number]; depth: number; name: string },
) {
  const { t } = useTranslation();
  const { openFile, file } = props;
  const open = useCallback(() => openFile(file.path), [openFile, file.path]);
  const rowStyle = useMemo(
    () => [styles.row, { paddingLeft: treeRowPaddingLeft(props.depth) }],
    [props.depth],
  );
  return (
    <View style={rowStyle}>
      <ContextMenu>
        <ContextMenuTrigger
          style={styles.rowBody}
          onPress={open}
          accessibilityRole="button"
          accessibilityLabel={`${t("vcs.openFile")}: ${file.path}`}
          testID={`vcs-status-file-${file.path}`}
        >
          <Text style={styles.text}>{props.name}</Text>
          <Text style={file.conflict ? styles.error : styles.muted}>
            {file.conflict ? t("vcs.conflict") : file.status}
          </Text>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <VcsFileActions
            {...props}
            path={file.path}
            kind="file"
            files={props.context.snapshot.files}
          />
          <ContextMenuItem onSelect={open}>{t("vcs.openFile")}</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    </View>
  );
}

function fileKey(file: StatusTreeRow) {
  return `${file.kind}:${file.path}`;
}
function EmptyStatus() {
  const { t } = useTranslation();
  return <Text style={styles.empty}>{t("vcs.empty")}</Text>;
}

function StatusDirectory(
  props: Props & {
    row: Extract<StatusTreeRow, { kind: "directory" }>;
    toggleFolder(path: string): void;
  },
) {
  const { t } = useTranslation();
  const { row, toggleFolder } = props;
  const accessibilityState = useMemo(() => ({ expanded: !row.collapsed }), [row.collapsed]);
  const toggle = useCallback(() => toggleFolder(row.path), [toggleFolder, row.path]);
  const rowStyle = useMemo(
    () => [styles.row, { paddingLeft: treeRowPaddingLeft(row.depth) }],
    [row.depth],
  );
  return (
    <ContextMenu>
      <ContextMenuTrigger
        style={rowStyle}
        onPress={toggle}
        accessibilityRole="button"
        accessibilityLabel={row.path}
        accessibilityState={accessibilityState}
        aria-expanded={!row.collapsed}
        testID={`vcs-status-folder-${row.path}`}
      >
        <TreeChevron expanded={!row.collapsed} />
        <Text style={styles.text}>{row.name}</Text>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <VcsFileActions
          {...props}
          path={row.path}
          kind="directory"
          files={props.context.snapshot.files}
        />
        <ContextMenuItem onSelect={toggle} disabled={row.collapsed}>
          {t("workspace.fileActions.collapseFolder")}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
