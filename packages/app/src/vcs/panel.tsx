import { prepareVcsConfirmation } from "./action-confirmation";
import { VcsStatusFiles } from "./status-files";
import { useWorkspace } from "@/stores/session-store-hooks";
import { useChangesPreferences } from "@/hooks/use-changes-preferences";
import { gitComparisonDefaults } from "./git-comparison-compat";
import { applyComparisonRequest } from "./selection";
import { vcsViews, availableVcsView } from "./views";
import { useVcsViewRequest } from "./use-view-request";
import type { PluginVcsComparisonResult } from "@getpaseo/plugin/client";
import { useCallback, useEffect, useMemo, useState, useRef } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { RefreshCw } from "lucide-react-native";
import { withUnistyles } from "react-native-unistyles";
import type {
  PluginVcsContext,
  PluginVcsSelection,
  PluginVcsActionContribution,
  PluginText,
} from "@getpaseo/plugin/client";
import type { JsonValue } from "@getpaseo/protocol/agent-types";
import type { VcsSnapshot, VcsComparison, VcsOperation } from "@getpaseo/protocol/vcs";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { PaneContentToolbar, ToolbarButton } from "@/components/ui/pane-content-toolbar";
import { SelectField } from "@/components/ui/select-field";
import { Button } from "@/components/ui/button";
import { confirmDialog } from "@/utils/confirm-dialog";
import { ScrollView } from "@/components/ui/scroll-view";
import { useHostFeature } from "@/runtime/host-features";
import { useInstalledPlugins, pluginRegistry } from "@/plugins/registry";
import type { ChangesState } from "@/panels/changes/state";
import { resolveVcsContribution } from "./contributions";
import {
  useVcsSnapshot,
  type VcsSnapshotQuery,
  useVcsHistory,
  useVcsDiff,
  useWorkspaceVcs,
} from "./queries";
import { useVcsOperation } from "./use-operation";
import { VcsActionSheet, type VcsActionDialog } from "./action-sheet";
import { defaultVcsPaneState, type VcsPaneState } from "./state";
import { selectionRevision } from "./selection";
import { resolvePaneComparison } from "./comparison";
import { vcsStyles as styles } from "./styles";
import { VcsPluginSurface } from "./plugin-surface";
import { VcsPublicationPanel } from "./publication-panel";
import { VcsWorkingCopyPanel } from "./working-copy-panel";
import { VcsComparisonPicker } from "./comparison-picker";
import { VcsActions, VcsChanges, VcsHistory, VcsRefRow } from "./data-view";
const RefreshIcon = withUnistyles(RefreshCw);
const WORKING_COMPARISON: VcsComparison = { kind: "working-copy" };
const EMPTY_FILES: import("@getpaseo/protocol/diff").ParsedDiffFile[] = [];
interface Props {
  serverId: string;
  workspaceId: string;
  state: ChangesState;
  setState(state: ChangesState): void;
  openFile(path: string): void;
  focusPath?: string;
  focusRequestId?: number;
  actionRequest?: import("@/workspace-tabs/model").WorkspaceWorkingDiffTabTarget["vcsAction"];
  comparisonRequest?: import("./state").VcsComparisonRequest;
  viewRequest?: import("./state").VcsViewRequest;
}
export function VcsPanel(props: Props) {
  const { t } = useTranslation();
  const supported = useHostFeature(props.serverId, "vcsDiffFiles");
  return supported ? (
    <VcsSnapshotSource {...props} />
  ) : (
    <Text style={styles.error}>{t("vcs.updateHost")}</Text>
  );
}
function VcsSnapshotSource(props: Props) {
  const active = useRetainedPanelActive();
  const snapshotQuery = useVcsSnapshot(props.serverId, props.workspaceId, active);
  return <VcsPanelContent {...props} snapshotQuery={snapshotQuery} />;
}
function VcsPanelContent(props: Props & { snapshotQuery: VcsSnapshotQuery }) {
  const { serverId, workspaceId } = props;
  const { t } = useTranslation();
  const active = useRetainedPanelActive();
  const { connected, providerId } = useWorkspaceVcs(serverId, workspaceId);
  const { snapshotQuery } = props;
  const installed = useInstalledPlugins();
  const state = useMemo(() => {
    const saved = paneVcsState(props.state.vcs, providerId);
    return { ...saved, view: availableVcsView(snapshotQuery.data, saved.view) };
  }, [props.state.vcs, providerId, snapshotQuery.data]);
  const { setState: setPaneState, state: paneState } = props;
  const setState = useCallback(
    (next: VcsPaneState) => setPaneState({ ...paneState, vcs: next }),
    [setPaneState, paneState],
  );
  const [launchError, setLaunchError] = useState<string | null>(null);
  useVcsViewRequest({
    serverId,
    active,
    snapshot: snapshotQuery.data,
    request: props.viewRequest,
    state,
    setState,
    setError: setLaunchError,
  });
  useEffect(() => {
    const next = applyComparisonRequest(state, props.comparisonRequest, providerId);
    if (next !== state) setState(next);
  }, [state, props.comparisonRequest, providerId, setState]);
  const [opened, setOpened] = useState<VcsActionDialog | null>(null);
  const dialog = useMemo(() => {
    if (!opened) return null;
    const current = installed.find(
      (plugin) => plugin.serverId === serverId && plugin.id === opened.plugin.id,
    );
    return current?.clientBundle === opened.plugin.clientBundle &&
      !opened.plugin.lifetime.signal.aborted
      ? opened
      : null;
  }, [opened, installed, serverId]);
  const snapshot = dialog?.context.snapshot ?? snapshotQuery.data;
  const selection = dialog?.context.selection ?? state.selection;
  const workspace = useWorkspace(serverId, workspaceId);
  const { preferences } = useChangesPreferences();
  const comparisonResult = useMemo<PluginVcsComparisonResult | undefined>(() => {
    if (!snapshot) return;
    try {
      const owner = resolveVcsContribution(installed, serverId, snapshot.binding.providerId);
      let defaults = workspace?.vcsSavedComparison;
      // COMPAT(vcsLegacyComparisonDefaults): v0.15.2; older hosts provide resolved defaults until 2027-06-06.
      if (defaults === undefined) defaults = workspace?.vcsComparisonDefaults;
      if (defaults === undefined) defaults = gitComparisonDefaults(workspace);

      return resolvePaneComparison({
        snapshot,
        state,
        selection,
        form: !!dialog,
        contribution: owner?.contribution,
        defaults: defaults ?? undefined,
        ignoreWhitespace: preferences.hideWhitespace,
      });
    } catch (error) {
      return { comparison: null, error: String(error), reviewScope: "invalid" };
    }
  }, [
    snapshot,
    dialog,
    selection,
    state,
    installed,
    serverId,
    workspace,
    preferences.hideWhitespace,
  ]);
  const comparison = comparisonResult?.comparison ?? null;
  const history = useVcsHistory(
    serverId,
    workspaceId,
    snapshot,
    active && !!snapshot && needsHistory(state.view, dialog),
  );
  const revisions = useMemo(
    () => history.data?.pages.flatMap((page) => page.revisions) ?? [],
    [history.data],
  );
  const diff = useVcsDiff(
    serverId,
    workspaceId,
    snapshot,
    comparison ?? WORKING_COMPARISON,
    active && !!snapshot && !!comparison && (state.view === "changes" || !!dialog),
  );
  const operation = useVcsOperation({ serverId, workspaceId, enabled: active, state, setState });
  const request = props.actionRequest;
  useEffect(() => {
    if (
      !active ||
      !request ||
      !snapshotQuery.data ||
      request.requestId === state.consumedActionRequestId
    )
      return;
    setState({ ...state, consumedActionRequestId: request.requestId });
    setLaunchError(null);
    try {
      const current = snapshotQuery.data;
      if (request.providerId !== current.binding.providerId)
        throw new Error(t("vcs.actionUnavailable"));
      if (operation.pending) throw new Error(t("vcs.operationPending"));
      if (snapshotQuery.error) throw snapshotQuery.error;
      const owner = resolveVcsContribution(installed, serverId, request.providerId);
      const action = owner?.contribution.actions.find(
        (item) => item.id === request.actionId && item.contexts.includes("workspace"),
      );
      const availability = current.actions.find((item) => item.id === request.actionId);
      if (!owner || !action || !availability?.enabled)
        throw new Error(availability?.reason ?? t("vcs.actionUnavailable"));
      setOpened({
        plugin: owner.plugin,
        action,
        context: {
          workspaceId,
          snapshot: current,
          selection: { kind: "workspace" },
          revisions: [],
          files: [],
        },
      });
    } catch (error) {
      setLaunchError(error instanceof Error ? error.message : String(error));
    }
  }, [
    active,
    request,
    state,
    setState,
    snapshotQuery.data,
    snapshotQuery.error,
    operation.pending,
    installed,
    serverId,
    workspaceId,
    t,
  ]);
  const { refetch: refetchHistory } = history;
  const { refetch: refetchDiff } = diff;
  const retryReads = useCallback(() => {
    void refetchHistory();
    void refetchDiff();
  }, [refetchHistory, refetchDiff]);
  const reads = actionReadState(snapshot, history, diff, comparison);
  const { refetch: refreshSnapshot } = snapshotQuery;
  const { refresh: refreshOperation, start: startOperation } = operation;
  const refresh = useCallback(() => {
    void refreshSnapshot();
    if (state.operation) void refreshOperation();
  }, [refreshSnapshot, refreshOperation, state.operation]);
  const onAction = useCallback(
    (action: PluginVcsActionContribution<PluginText>, context: PluginVcsContext) => {
      const resolved = resolveVcsContribution(
        pluginRegistry.getSnapshot(),
        serverId,
        context.snapshot.binding.providerId,
      );
      if (resolved) setOpened({ action, context, plugin: resolved.plugin });
    },
    [serverId],
  );
  const execute = useCallback(
    async (action: string, input: JsonValue, context: PluginVcsContext) => {
      const resolved = resolveVcsContribution(
        pluginRegistry.getSnapshot(),
        serverId,
        context.snapshot.binding.providerId,
      );
      if (!resolved?.contribution.actions.some((item) => item.id === action))
        throw new Error("The VCS plugin changed. Reopen the action.");
      await startOperation(
        context.snapshot.binding.providerId,
        {
          kind: "action",
          version: context.snapshot.version,
          action,
          input,
        },
        true,
      );
    },
    [serverId, startOperation],
  );
  const close = useCallback(() => setOpened(null), []);
  const actionDialog = useMemo(
    () =>
      dialog
        ? {
            ...dialog,
            context: {
              ...dialog.context,
              revisions,
              files: (dialog.context.snapshot.capabilities.includes("diff")
                ? (diff.data ?? [])
                : dialog.context.snapshot.files
              ).map((file) => file.path),
            },
          }
        : null,
    [dialog, revisions, diff.data],
  );
  if (!snapshot)
    return (
      <SnapshotPending
        error={snapshotQuery.error?.message}
        connected={connected}
        loading={snapshotQuery.isFetching}
        refresh={refresh}
      />
    );
  return (
    <>
      <LoadedVcsPanel
        {...props}
        snapshot={snapshot}
        active={active}
        connected={connected}
        stateVcs={state}
        setVcsState={setState}
        history={history}
        revisions={revisions}
        diff={diff}
        ambiguous={!comparison}
        comparison={comparison}
        comparisonResult={comparisonResult}
        operation={operation}
        refresh={refresh}
        refreshing={snapshotQuery.isFetching}
        snapshotError={launchError ?? snapshotQuery.error?.message}
        onAction={onAction}
        execute={execute}
      />
      <VcsActionSheet
        serverId={props.serverId}
        dialog={actionDialog}
        {...reads}
        retry={retryReads}
        pending={operation.pending}
        close={close}
        execute={execute}
      />
    </>
  );
}
function paneVcsState(
  saved: VcsPaneState | undefined,
  providerId: string | undefined,
): VcsPaneState {
  return saved?.providerId === providerId && saved ? saved : { ...defaultVcsPaneState, providerId };
}
function actionReadState(
  snapshot: VcsSnapshot | undefined,
  history: ReturnType<typeof useVcsHistory> | null,
  diff: ReturnType<typeof useVcsDiff> | null,
  comparison: VcsComparison | null,
) {
  return {
    loading:
      (snapshot?.capabilities.includes("history") === true && history?.isPending === true) ||
      (snapshot?.capabilities.includes("diff") === true &&
        comparison !== null &&
        diff?.isPending === true),
    error:
      (snapshot?.capabilities.includes("history") ? history?.error?.message : undefined) ??
      (snapshot?.capabilities.includes("diff") && comparison !== null
        ? diff?.error?.message
        : undefined),
  };
}
function needsHistory(view: string, dialog: VcsActionDialog | null) {
  return view === "history" || view === "refs" || view === "working-copy" || dialog !== null;
}
function SnapshotPending(props: {
  error?: string;
  connected: boolean;
  loading: boolean;
  refresh(): void;
}) {
  const { t } = useTranslation();
  return (
    <View style={styles.empty} testID="vcs-panel">
      <Text
        accessibilityRole={props.error ? "alert" : undefined}
        style={props.error ? styles.error : styles.text}
      >
        {props.error ?? t(props.connected ? "vcs.loading" : "vcs.offline")}
      </Text>
      <Button
        testID="vcs-refresh"
        variant="ghost"
        disabled={!props.connected || props.loading}
        onPress={props.refresh}
      >
        {t("vcs.refresh")}
      </Button>
    </View>
  );
}
type LoadedProps = Props & {
  snapshot: VcsSnapshot;
  active: boolean;
  connected: boolean;
  stateVcs: VcsPaneState;
  setVcsState(state: VcsPaneState): void;
  history: ReturnType<typeof useVcsHistory>;
  revisions: PluginVcsContext["revisions"] & import("@getpaseo/protocol/vcs").VcsRevision[];
  diff: ReturnType<typeof useVcsDiff>;
  ambiguous: boolean;
  comparison: VcsComparison | null;
  comparisonResult?: PluginVcsComparisonResult;
  operation: ReturnType<typeof useVcsOperation>;
  refresh(): void;
  refreshing: boolean;
  snapshotError?: string;
  onAction(action: PluginVcsActionContribution<PluginText>, context: PluginVcsContext): void;
  execute(action: string, input: JsonValue, context: PluginVcsContext): Promise<void>;
};
function LoadedVcsPanel(props: LoadedProps) {
  const { t } = useTranslation();
  const installed = useInstalledPlugins();
  const { stateVcs: state, snapshot } = props;
  const resolution = useMemo(() => {
    try {
      return {
        resolved: resolveVcsContribution(installed, props.serverId, snapshot.binding.providerId),
        error: null,
      };
    } catch (error) {
      return { resolved: null, error: String(error) };
    }
  }, [installed, props.serverId, snapshot.binding.providerId]);
  const resolved = resolution.resolved;
  const context = useMemo<PluginVcsContext>(
    () => ({
      workspaceId: props.workspaceId,
      snapshot,
      selection: state.selection,
      revisions: props.revisions,
      files: (snapshot.capabilities.includes("diff")
        ? (props.diff.data ?? [])
        : snapshot.files
      ).map((file) => file.path),
    }),
    [props.workspaceId, snapshot, state.selection, props.revisions, props.diff.data],
  );
  const { setVcsState } = props;
  const { fetchNextPage } = props.history;
  const select = useCallback(
    (selection: PluginVcsSelection) => setVcsState({ ...state, selection, view: "changes" }),
    [setVcsState, state],
  );
  const working = useCallback(() => select({ kind: "workspace" }), [select]);
  const changeView = useCallback(
    (view: string) => setVcsState({ ...state, view }),
    [setVcsState, state],
  );
  const dismiss = useCallback(() => {
    const { operation: _operation, ...rest } = state;
    setVcsState(rest);
  }, [setVcsState, state]);
  const more = useCallback(() => {
    void fetchNextPage();
  }, [fetchNextPage]);
  const views = useMemo(() => {
    return vcsViews(
      snapshot,
      resolved?.contribution,
      (title) => resolved!.plugin.i18n.resolve(title, resolved!.plugin.locale),
      {
        changes: t("vcs.changes"),
        history: t("vcs.history"),
        refs: t("vcs.refs"),
        publish: t("vcs.publish"),
        workingCopy: t("vcs.createWorkingCopy"),
      },
    ).map((view) => ({ id: view.id, value: view.id, label: view.title }));
  }, [t, snapshot, resolved]);
  const view = views.find((entry) => entry.value === state.view) ?? views[0]!;
  const display = useMemo(() => ({ label: view.label }), [view.label]);
  const disabled = !props.connected || props.operation.pending;
  return (
    <View style={styles.container} testID="vcs-panel">
      <PaneContentToolbar style={styles.toolbar}>
        <View style={styles.rowBody}>
          <SelectField
            field={false}
            label={t("vcs.title")}
            value={view.value}
            selectedDisplay={display}
            options={views}
            onChange={changeView}
            placeholder={t("vcs.title")}
            emptyText=""
            size="sm"
            testID="vcs-view"
          />
        </View>
        <ToolbarButton
          label={t("vcs.refresh")}
          disabled={!props.connected || props.refreshing}
          onPress={props.refresh}
          testID="vcs-refresh"
        >
          <RefreshIcon size={16} />
        </ToolbarButton>
        <VcsActions
          resolved={resolved}
          context={context}
          disabled={disabled}
          onAction={props.onAction}
        />
      </PaneContentToolbar>
      {snapshot.capabilities.includes("diff") ? (
        <VcsComparisonPicker
          snapshot={snapshot}
          resolved={resolved}
          state={state}
          setState={setVcsState}
          result={props.comparisonResult}
        />
      ) : null}
      <VcsSelection
        context={context}
        title={
          resolved
            ? resolved.plugin.i18n.resolve(resolved.contribution.title, resolved.plugin.locale)
            : snapshot.binding.providerId
        }
        working={working}
      />
      {resolution.error || props.snapshotError ? (
        <Text style={styles.error} accessibilityRole="alert">
          {resolution.error ?? props.snapshotError}
        </Text>
      ) : null}
      {state.operation ? (
        <OperationNotice
          operation={props.operation.operation}
          pending={props.operation.pending}
          error={props.operation.error?.message}
          dismiss={dismiss}
        />
      ) : null}
      {!props.connected ? <Text style={styles.error}>{t("vcs.offline")}</Text> : null}
      <View style={styles.body}>
        <VcsBody
          {...props}
          view={view.value}
          resolved={resolved}
          context={context}
          select={select}
          more={more}
          disabled={disabled}
        />
      </View>
    </View>
  );
}
function VcsSelection({
  context,
  title,
  working,
}: {
  context: PluginVcsContext;
  title: string;
  working(): void;
}) {
  const { t } = useTranslation();
  const revision = selectionRevision(context.selection, context.snapshot);
  let name = t("vcs.workingCopy");
  if (context.selection.kind === "ref") name = context.selection.ref.name;
  if (context.selection.kind === "revision")
    name = revision?.changeId ?? revision?.id.slice(0, 12) ?? "";
  return (
    <View style={styles.selection}>
      <Text style={styles.text}>
        {title} · {name}
      </Text>
      {context.selection.kind !== "workspace" ? (
        <Button size="sm" variant="ghost" onPress={working}>
          {t("vcs.workingCopy")}
        </Button>
      ) : null}
      {context.snapshot.state === "stale" ? (
        <Text style={styles.error}>{t("vcs.stale")}</Text>
      ) : null}
    </View>
  );
}
function OperationNotice(props: {
  operation?: VcsOperation;
  pending: boolean;
  error?: string;
  dismiss(): void;
}) {
  const { t } = useTranslation();
  let message = t("vcs.operationSucceeded");
  if (props.pending) message = t("vcs.operationPending");
  if (props.operation?.status === "unknown") message = t("vcs.operationUnknown");
  message = props.operation?.error?.message ?? props.error ?? message;
  const failed = !!props.error || !!props.operation?.error || props.operation?.status === "unknown";
  return (
    <View style={styles.notice} testID="vcs-operation">
      <Text
        style={failed ? styles.error : styles.text}
        accessibilityRole={failed ? "alert" : undefined}
      >
        {message}
      </Text>
      {!props.pending ? (
        <Button size="sm" variant="ghost" onPress={props.dismiss}>
          {t("vcs.dismiss")}
        </Button>
      ) : null}
    </View>
  );
}
function VcsBody(
  props: LoadedProps & {
    view: string;
    resolved: ReturnType<typeof resolveVcsContribution>;
    context: PluginVcsContext;
    disabled: boolean;
    select(selection: PluginVcsSelection): void;
    more(): void;
  },
) {
  const { t } = useTranslation();
  const extra = props.resolved?.contribution.panels?.find(
    (panel) => `plugin:${panel.id}` === props.view,
  );
  const { execute } = props;
  const { vcs } = useWorkspaceVcs(props.serverId, props.workspaceId);
  const extraSubmitting = useRef(false);
  const [extraError, setExtraError] = useState<string | null>(null);
  const runExtra = useCallback(
    async (id: string, input: JsonValue) => {
      if (extraSubmitting.current) return;
      extraSubmitting.current = true;
      setExtraError(null);
      try {
        if (props.disabled)
          throw new Error("Wait for the current VCS operation or reconnect the host");
        const owner = props.resolved;
        const action = owner?.contribution.actions.find((candidate) => candidate.id === id);
        if (!owner || !action) throw new Error("The VCS action is unavailable");
        const confirmation = await prepareVcsConfirmation({
          vcs,
          dialog: { plugin: owner.plugin, action, context: props.context },
          input,
        });
        if (
          confirmation &&
          !(await confirmDialog({
            title: owner.plugin.i18n.resolve(action.title, owner.plugin.locale),
            message: confirmation.message,
            destructive: confirmation.destructive,
            cancelLabel: t("common.cancel"),
          }))
        )
          return;
        await execute(id, input, props.context);
      } catch (error) {
        setExtraError(error instanceof Error ? error.message : String(error));
      } finally {
        extraSubmitting.current = false;
      }
    },
    [execute, props.context, props.resolved, props.disabled, t, vcs],
  );
  const renderExtra = useCallback(
    (surface: import("@getpaseo/plugin/client").PluginSurfaceProps) =>
      extra ? (
        <extra.Component
          {...surface}
          context={props.context}
          refresh={props.refresh}
          runAction={runExtra}
        />
      ) : null,
    [extra, props.context, props.refresh, runExtra],
  );
  if (props.view === "changes") return <ChangesBody {...props} />;
  if (props.view === "history")
    return (
      <VcsHistory
        rows={props.revisions}
        loading={props.history.isFetching && !props.revisions.length}
        error={props.history.error?.message}
        select={props.select}
        context={props.context}
        resolved={props.resolved}
        disabled={props.disabled}
        onAction={props.onAction}
        loadMore={props.more}
        hasMore={!!props.history.hasNextPage}
        loadingMore={props.history.isFetchingNextPage}
      />
    );
  if (props.view === "refs")
    return (
      <ScrollView>
        <View>
          {props.snapshot.refs.map((reference) => (
            <VcsRefRow
              key={reference.id}
              reference={reference}
              revisions={props.revisions}
              select={props.select}
              context={props.context}
              resolved={props.resolved}
              disabled={props.disabled}
              onAction={props.onAction}
            />
          ))}
          {!props.snapshot.refs.length ? <Text style={styles.empty}>{t("vcs.noRefs")}</Text> : null}
        </View>
      </ScrollView>
    );
  if (props.view === "working-copy")
    return (
      <VcsWorkingCopyPanel
        serverId={props.serverId}
        workspaceId={props.workspaceId}
        snapshot={props.snapshot}
        revisions={props.revisions}
        state={props.stateVcs}
        setState={props.setVcsState}
        pending={props.disabled}
        hasMore={!!props.history.hasNextPage}
        loadMore={props.more}
        historyError={props.history.error?.message}
        loadingMore={props.history.isFetchingNextPage}
      />
    );
  if (props.view === "publish")
    return (
      <VcsPublicationPanel
        serverId={props.serverId}
        workspaceId={props.workspaceId}
        snapshot={props.snapshot}
        state={props.stateVcs}
        setState={props.setVcsState}
        operation={props.operation}
        active={props.active}
      />
    );
  if (extra && props.resolved)
    return (
      <View style={styles.container}>
        {extraError ? (
          <Text accessibilityRole="alert" style={styles.error}>
            {extraError}
          </Text>
        ) : null}
        <VcsPluginSurface plugin={props.resolved.plugin}>{renderExtra}</VcsPluginSurface>
      </View>
    );
  return null;
}

function comparisonError(props: LoadedProps, ambiguous: string): string | undefined {
  return props.comparisonResult?.error ?? (props.ambiguous ? ambiguous : props.diff.error?.message);
}

function ChangesBody(
  props: LoadedProps & {
    disabled: boolean;
    context: PluginVcsContext;
    resolved: ReturnType<typeof resolveVcsContribution>;
  },
) {
  const { t } = useTranslation();
  if (!props.snapshot.capabilities.includes("diff"))
    return (
      <VcsStatusFiles
        state={props.state}
        setState={props.setState}
        context={props.context}
        openFile={props.openFile}
        resolved={props.resolved}
        onAction={props.onAction}
        disabled={props.disabled}
      />
    );
  return (
    <VcsChanges
      serverId={props.serverId}
      workspaceId={props.workspaceId}
      files={props.diff.data ?? EMPTY_FILES}
      snapshotFiles={props.snapshot.files}
      context={props.context}
      resolved={props.resolved}
      onAction={props.onAction}
      disabled={props.disabled}
      comparison={props.comparison ?? WORKING_COMPARISON}
      reviewScope={props.comparisonResult?.reviewScope}
      loading={props.diff.isFetching && !props.diff.data}
      error={comparisonError(props, t("vcs.ambiguous"))}
      openFile={props.openFile}
      focusPath={props.focusPath}
      focusRequestId={props.focusRequestId}
      state={props.state}
      setState={props.setState}
    />
  );
}
