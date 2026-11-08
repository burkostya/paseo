import { resolveChangesPresentation } from "@/panels/changes/presentation";
import { defaultVcsPaneState } from "./state";
import { useVcsReview } from "./review";
import { VcsFileActions, useVcsFileCommands } from "./file-actions";
import { ReviewCommentSheet, ReviewFeedbackAction } from "@/review";
import { useRetainedPanelActive } from "@/components/retained-panel";
import type { VcsComparison } from "@getpaseo/protocol/vcs";
import { usePaneContext } from "@/panels/pane-context";
import { TreeRail } from "@/components/tree-rail";
import { TreeRailToggle } from "@/components/tree-rail-toggle";
import { ChangedFilesTree } from "@/git/changed-files-tree";
import { DiffLayoutToggle } from "@/git/diff-pane";
import { useIsCompactFormFactor } from "@/constants/layout";
import { isWeb, isNative } from "@/constants/platform";
import { useAddFileToChat } from "@/panels/use-add-file-to-chat";
import { PaneContentToolbar } from "@/components/ui/pane-content-toolbar";
import { useCallback, useMemo, useState, type ReactNode } from "react";
import { FlatList, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import Svg, { Circle, Line } from "react-native-svg";
import { withUnistyles } from "react-native-unistyles";
import type { VcsRevision, VcsRef, VcsSnapshot } from "@getpaseo/protocol/vcs";
import type {
  PluginVcsContext,
  PluginVcsSelection,
  PluginVcsActionContribution,
  PluginText,
} from "@getpaseo/plugin/client";
import { MoreHorizontal, Space, WrapText } from "lucide-react-native";
import { Button } from "@/components/ui/button";
import { PluginIconView } from "@/plugins/icons";
import { mutedIconColorMapping } from "@/components/ui/icon-button-chrome";
import { PressHighlight } from "@/components/ui/press-highlight";
import { ToolbarButton } from "@/components/ui/pane-content-toolbar";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { DiffDocument } from "@/git/diff-document";
import { useChangesPreferences } from "@/hooks/use-changes-preferences";
import { useAppSettings } from "@/hooks/use-settings";
import type { ChangesState } from "@/panels/changes/state";
import { revisionGraph } from "./graph";
import { vcsContextActions, type resolveVcsContribution } from "./contributions";
import { vcsStyles as styles } from "./styles";
const WrapIcon = withUnistyles(WrapText, mutedIconColorMapping);
const WhitespaceIcon = withUnistyles(Space, mutedIconColorMapping);
const ActionsIcon = withUnistyles(MoreHorizontal);
const ActionIcon = withUnistyles(PluginIconView, mutedIconColorMapping);
export interface ActionTargetProps {
  resolved: ReturnType<typeof resolveVcsContribution>;
  context: PluginVcsContext;
  disabled: boolean;
  onAction(action: PluginVcsActionContribution<PluginText>, context: PluginVcsContext): void;
}
export function VcsActions(props: ActionTargetProps) {
  const { t } = useTranslation();
  const items = useMemo(
    () =>
      props.resolved ? vcsContextActions(props.resolved.contribution.actions, props.context) : [],
    [props.resolved, props.context],
  );
  if (!items.length || !props.resolved) return null;
  return (
    <DropdownMenu>
      <ToolbarButton
        kind="menu"
        label={t("vcs.actions")}
        disabled={props.disabled}
        testID="vcs-actions"
      >
        <ActionsIcon size={16} />
      </ToolbarButton>
      <DropdownMenuContent>
        {items.map((item) => (
          <ActionItem key={item.action.id} {...props} item={item} />
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
function ActionItem(
  props: ActionTargetProps & { item: ReturnType<typeof vcsContextActions>[number] },
) {
  const { onAction } = props;
  const select = useCallback(
    () => onAction(props.item.action, props.context),
    [onAction, props.item.action, props.context],
  );
  const title = props.resolved!.plugin.i18n.resolve(
    props.item.action.title,
    props.resolved!.plugin.locale,
  );
  const leading = useMemo(
    () => (props.item.action.icon ? <ActionIcon icon={props.item.action.icon} size={16} /> : null),
    [props.item.action.icon],
  );
  return (
    <DropdownMenuItem
      leading={leading}
      disabled={props.disabled || !props.item.availability.enabled}
      description={props.item.availability.reason}
      onSelect={select}
      testID={`vcs-action-${props.item.action.id}`}
    >
      {title}
    </DropdownMenuItem>
  );
}
interface ChangesProps extends ActionTargetProps {
  comparison: VcsComparison;
  reviewScope?: string;
  serverId: string;
  workspaceId: string;
  files: import("@getpaseo/protocol/diff").ParsedDiffFile[];
  snapshotFiles: VcsSnapshot["files"];
  loading: boolean;
  error?: string;
  openFile(path: string): void;
  focusPath?: string;
  focusRequestId?: number;
  state: ChangesState;
  setState(state: ChangesState): void;
}
export function VcsChanges(props: ChangesProps) {
  const { t } = useTranslation();
  const { setState, state } = props;
  const { preferences, updatePreferences } = useChangesPreferences();
  const compact = useIsCompactFormFactor();
  const canSplit = isWeb && !compact;
  const active = useRetainedPanelActive();
  const reviewEnabled = active && !props.loading && !props.error;
  const { openTargetToSide, openPreferredTarget, target } = usePaneContext();
  const treeOnly =
    resolveChangesPresentation({
      isTree: target.kind === "changes_tree",
      inlineDiff: preferences.inlineDiff,
      isCompact: compact,
      isNative,
    }) === "tree";
  const side = useCallback(
    (path: string) => openTargetToSide?.({ kind: "file", path }),
    [openTargetToSide],
  );
  const commands = useVcsFileCommands(props);
  const { reviewActions, feedback } = useVcsReview({
    ...props,
    snapshot: props.context.snapshot,
    state: state.vcs ?? defaultVcsPaneState,
    enabled: reviewEnabled,
  });
  const renderFileActions = useCallback(
    (path: string, kind: "file" | "directory") => {
      return (
        <VcsFileActions
          resolved={props.resolved}
          context={props.context}
          path={path}
          files={props.files}
          disabled={props.disabled}
          onAction={props.onAction}
          kind={kind}
        />
      );
    },
    [props.context, props.files, props.resolved, props.disabled, props.onAction],
  );
  const { addFile, canAddToChat } = useAddFileToChat({
    serverId: props.serverId,
    workspaceId: props.workspaceId,
  });
  const [focus, setFocus] = useState<{ path: string; id: number } | null>(null);
  const selectFile = useCallback(
    (path: string) => {
      if (treeOnly) {
        openPreferredTarget(
          {
            kind: "working_diff",
            focusPath: path,
            focusRequestId: Date.now(),
            vcsComparison: {
              requestId: String(Date.now()),
              providerId: props.context.snapshot.binding.providerId,
              selection: props.context.selection,
              comparisonId: state.vcs?.comparisonId,
              baseRef: state.vcs?.baseRef,
              range: state.vcs?.range,
            },
          },
          "diffs",
        );
        return;
      }
      setFocus({ path, id: Date.now() });
      if (compact) setState({ ...state, treeVisible: false });
    },
    [compact, setState, state, treeOnly, openPreferredTarget, props.context],
  );
  const toggleTree = useCallback(
    () => setState({ ...state, treeVisible: !state.treeVisible }),
    [setState, state],
  );
  const toggleLayout = useCallback(() => {
    void updatePreferences({ layout: preferences.layout === "unified" ? "split" : "unified" });
  }, [updatePreferences, preferences.layout]);
  const toggleWhitespace = useCallback(() => {
    void updatePreferences({ hideWhitespace: !preferences.hideWhitespace });
  }, [updatePreferences, preferences.hideWhitespace]);
  const toggleWrap = useCallback(() => {
    void updatePreferences({ wrapLines: !preferences.wrapLines });
  }, [updatePreferences, preferences.wrapLines]);
  const folders = useCallback(
    (paths: string[]) => setState({ ...state, collapsedFolderPaths: paths }),
    [setState, state],
  );
  const { settings } = useAppSettings();
  const displayPreferences = useMemo(
    () => ({
      layout: canSplit ? preferences.layout : ("unified" as const),
      wrapLines: preferences.wrapLines,
      codeFontSize: settings.codeFontSize,
      monoFontFamily: settings.monoFontFamily,
    }),
    [
      canSplit,
      preferences.layout,
      preferences.wrapLines,
      settings.codeFontSize,
      settings.monoFontFamily,
    ],
  );
  const mode = useMemo(
    () => ({
      kind: "working" as const,
      onOpenFile: props.openFile,
      focusPath: focus?.path ?? props.focusPath,
      focusRequestId: focus?.id ?? props.focusRequestId,
      ...commands,
      renderFileActions,
      reviewActions,
      onOpenToSide: openTargetToSide ? side : undefined,
      onAddToChat: canAddToChat ? addFile : undefined,
    }),
    [
      props.openFile,
      props.focusPath,
      props.focusRequestId,
      focus,
      commands,
      renderFileActions,
      reviewActions,
      openTargetToSide,
      side,
      canAddToChat,
      addFile,
    ],
  );
  const collapse = useCallback(
    (paths: string[]) => setState({ ...state, collapsedFilePaths: paths }),
    [setState, state],
  );
  const collapseState = useMemo(
    () => ({ paths: state.collapsedFilePaths, onChange: collapse }),
    [state.collapsedFilePaths, collapse],
  );
  let body: ReactNode = <Text style={styles.empty}>{t("vcs.empty")}</Text>;
  if (props.files.length) {
    body = (
      <DiffDocument
        files={props.files}
        contentInsetBottom={feedback.clearance}
        displayPreferences={displayPreferences}
        mode={mode}
        collapseState={collapseState}
      />
    );
    if (state.treeVisible || treeOnly)
      body = (
        <ChangedFilesTree
          files={props.files}
          mode={mode}
          onSelectFile={selectFile}
          collapsedFolderPaths={state.collapsedFolderPaths}
          onCollapsedFolderPathsChange={folders}
        />
      );
    if (state.treeVisible && !compact && !treeOnly)
      body = (
        <TreeRail>
          <DiffDocument
            files={props.files}
            contentInsetBottom={feedback.clearance}
            displayPreferences={displayPreferences}
            mode={mode}
            collapseState={collapseState}
          />
          <ChangedFilesTree
            files={props.files}
            mode={mode}
            onSelectFile={selectFile}
            collapsedFolderPaths={state.collapsedFolderPaths}
            onCollapsedFolderPathsChange={folders}
          />
        </TreeRail>
      );
  }
  if (props.error)
    return (
      <Text style={styles.error} accessibilityRole="alert">
        {props.error}
      </Text>
    );
  if (props.loading) return <Text style={styles.empty}>{t("vcs.loading")}</Text>;
  return (
    <View style={styles.container}>
      {props.snapshotFiles
        .filter((file) => file.conflict)
        .map((file) => (
          <ConflictFile key={file.path} path={file.path} open={props.openFile} />
        ))}
      <PaneContentToolbar style={styles.toolbar} testID="vcs-diff-toolbar">
        {canSplit ? (
          <DiffLayoutToggle
            layout={preferences.layout}
            isMobile={compact}
            onToggle={toggleLayout}
          />
        ) : null}
        <ToolbarButton
          onPress={toggleWrap}
          selected={preferences.wrapLines}
          testID="changes-toggle-wrap-lines"
          label={t(
            preferences.wrapLines
              ? "workspace.git.diff.scrollLongLines"
              : "workspace.git.diff.wrapLongLines",
          )}
        >
          <WrapIcon size={16} />
        </ToolbarButton>
        {canCompareWhitespace(props) ? (
          <ToolbarButton
            onPress={toggleWhitespace}
            selected={preferences.hideWhitespace}
            label={t(preferences.hideWhitespace ? "vcs.showWhitespace" : "vcs.hideWhitespace")}
            testID="vcs-whitespace"
          >
            <WhitespaceIcon size={16} />
          </ToolbarButton>
        ) : null}
        <TreeRailToggle
          visible={state.treeVisible}
          onToggle={toggleTree}
          testID="vcs-tree-toggle"
        />
      </PaneContentToolbar>
      {body}
      <ReviewFeedbackAction
        bottomOffset={0}
        enabled={reviewEnabled}
        hasDiff={!treeOnly && (!state.treeVisible || !compact)}
        model={feedback.model}
        state={feedback.state}
        serverId={props.serverId}
        workspaceId={props.workspaceId}
      />
      <ReviewCommentSheet
        enabled={active}
        editor={reviewActions.sheetEditor}
        reviewActions={reviewActions}
        onChangeBody={reviewActions.onChangeEditorBody}
      />
    </View>
  );
}
function ConflictFile({ path, open }: { path: string; open(path: string): void }) {
  const { t } = useTranslation();
  const press = useCallback(() => open(path), [open, path]);
  return (
    <Button variant="ghost" onPress={press}>
      {t("vcs.conflict")}: {path}
    </Button>
  );
}
interface HistoryProps extends Omit<ActionTargetProps, "context"> {
  context: PluginVcsContext;
  rows: VcsRevision[];
  loading: boolean;
  error?: string;
  select(selection: PluginVcsSelection): void;
  loadMore(): void;
  hasMore: boolean;
  loadingMore: boolean;
}
export function VcsHistory(props: HistoryProps) {
  const { t } = useTranslation();
  const graph = useMemo(() => revisionGraph(props.rows), [props.rows]);
  const render = useCallback(
    ({ item, index }: { item: VcsRevision; index: number }) => (
      <HistoryRow
        revision={item}
        graph={graph[index]!}
        select={props.select}
        resolved={props.resolved}
        context={props.context}
        disabled={props.disabled}
        onAction={props.onAction}
      />
    ),
    [graph, props.select, props.resolved, props.context, props.disabled, props.onAction],
  );
  const footer = useMemo(
    () =>
      props.hasMore ? (
        <Button variant="ghost" loading={props.loadingMore} onPress={props.loadMore}>
          {t("vcs.loadMore")}
        </Button>
      ) : null,
    [props.hasMore, props.loadingMore, props.loadMore, t],
  );
  if (props.error) return <Text style={styles.error}>{props.error}</Text>;
  if (props.loading) return <Text style={styles.empty}>{t("vcs.loading")}</Text>;
  return (
    <FlatList
      data={props.rows}
      keyExtractor={revisionKey}
      renderItem={render}
      ListFooterComponent={footer}
    />
  );
}
const revisionKey = (revision: VcsRevision) => revision.id;
function HistoryRow(
  props: ActionTargetProps & {
    revision: VcsRevision;
    graph: ReturnType<typeof revisionGraph>[number];
    select(selection: PluginVcsSelection): void;
  },
) {
  const { t } = useTranslation();
  const context = useMemo<PluginVcsContext>(
    () => ({ ...props.context, selection: { kind: "revision", revision: props.revision } }),
    [props.context, props.revision],
  );
  const { select: onSelect } = props;
  const select = useCallback(() => onSelect(context.selection), [onSelect, context.selection]);
  return (
    <View style={styles.historyRow}>
      <Graph graph={props.graph} />
      <PressHighlight
        style={[styles.rowBody, styles.historyBody]}
        onPress={select}
        testID={`vcs-revision-${props.revision.id}`}
      >
        <Text style={styles.text} numberOfLines={2}>
          {props.revision.description.trim() || t("vcs.noDescription")}
        </Text>
        <Text style={styles.muted}>
          {props.revision.changeId ? `${props.revision.changeId.slice(0, 12)} · ` : ""}
          {props.revision.id.slice(0, 12)}
          {props.revision.conflict ? ` · ${t("vcs.conflict")}` : ""}
        </Text>
        <Text style={styles.muted}>
          {props.revision.author.name} · {t("vcs.parents")}:{" "}
          {props.revision.parents.map((id) => id.slice(0, 8)).join(", ") || "—"}
        </Text>
      </PressHighlight>
      <VcsActions {...props} context={context} />
    </View>
  );
}
function RevisionGraph({
  graph,
  color,
}: {
  graph: ReturnType<typeof revisionGraph>[number];
  color: string;
}) {
  return (
    <View style={styles.graphWidth(graph.width * 12 + 8)}>
      <Svg
        width="100%"
        height="100%"
        viewBox={`0 0 ${graph.width * 12 + 8} 100`}
        preserveAspectRatio="none"
      >
        {graph.incoming ? (
          <Line x1={graph.lane * 12 + 8} y1={0} x2={graph.lane * 12 + 8} y2={22} stroke={color} />
        ) : null}
        <Circle cx={graph.lane * 12 + 8} cy={22} r={3} fill={color} />
        {graph.edges.map((edge) => (
          <Line
            key={`${edge.from}:${edge.to}:${edge.parent}`}
            x1={edge.from * 12 + 8}
            y1={edge.from === graph.lane ? 22 : 0}
            x2={edge.to * 12 + 8}
            y2={100}
            stroke={color}
          />
        ))}
      </Svg>
    </View>
  );
}
const Graph = withUnistyles(RevisionGraph, (theme) => ({ color: theme.colors.foregroundMuted }));
export function VcsRefRow(
  props: ActionTargetProps & {
    reference: VcsRef;
    revisions: VcsRevision[];
    select(selection: PluginVcsSelection): void;
  },
) {
  const context = useMemo<PluginVcsContext>(
    () => ({
      ...props.context,
      selection: {
        kind: "ref",
        ref: props.reference,
        revision:
          props.revisions.find(
            (item) =>
              props.reference.targets.length === 1 && item.id === props.reference.targets[0],
          ) ?? null,
      },
    }),
    [props.context, props.reference, props.revisions],
  );
  const { select: onSelect } = props;
  const select = useCallback(() => onSelect(context.selection), [onSelect, context.selection]);
  return (
    <View style={styles.row}>
      <PressHighlight style={styles.rowBody} onPress={select}>
        <Text style={styles.text}>
          {props.reference.name}
          {props.reference.remote ? `@${props.reference.remote}` : ""}
        </Text>
        <Text style={styles.muted}>
          {props.reference.targets.map((id) => id.slice(0, 12)).join(", ") || "—"}
        </Text>
      </PressHighlight>
      <VcsActions {...props} context={context} />
    </View>
  );
}
export function VcsStatusText({
  children,
  error = false,
}: {
  children: ReactNode;
  error?: boolean;
}) {
  return <Text style={error ? styles.error : styles.text}>{children}</Text>;
}

function canCompareWhitespace(props: ChangesProps): boolean {
  const contribution = props.resolved?.contribution;
  const workingCopy = props.context.selection.kind === "workspace" && !props.state.vcs?.range;
  return workingCopy
    ? !!contribution?.resolveComparison
    : !!contribution?.resolveRevisionComparison;
}
