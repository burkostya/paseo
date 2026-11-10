import { type PluginAgentPanelProps, useRpc, useSettings } from "@getpaseo/plugin/client";
import { useMemo, useCallback, useState, useEffect, useSyncExternalStore } from "react";
import { Button, SettingsCard, SettingsSelect, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ScrollView, Text, View } from "react-native";
import {
  startReview,
  getReview,
  prepareReview,
  openReview,
  updateReview,
  cancelReview,
  retryReview,
  requestGuide,
  cancelGuide,
  preferences,
  type ReviewState,
  type SourceSelection,
  type Revision,
  type Guide,
  type Delivery,
} from "../shared/review";
import { openReviewForm } from "./model";
const modes = [
  { value: "task", label: "Task commits" },
  { value: "change-request", label: "Workspace PR / MR" },
  { value: "working-copy", label: "Uncommitted changes" },
] as const;
type Action =
  | "start"
  | "open"
  | "update"
  | "cancel"
  | "agent-guide"
  | "native-guide"
  | "cancel-guide"
  | "retry";
interface Intent {
  action: Action;
  id?: string;
}

export function ReviewPanel(props: PluginAgentPanelProps) {
  const get = useRpc(getReview);
  const target = { agentId: props.params.agentId, workspaceId: props.workspaceId };
  const queryKey = ["plannotator-review", props.host.id, props.workspaceId, target.agentId];
  const query = useQuery({
    queryKey,
    queryFn: () => get(target),
    enabled: Boolean(props.navigation?.openBrowser),
    refetchInterval: 1000,
  });
  if (!props.navigation?.openBrowser)
    return <Text>Code review requires Electron and a daemon on this computer.</Text>;
  if (query.isPending) return <Text>Loading review…</Text>;
  if (query.isError) return <Text>{query.error.message}</Text>;
  return (
    <LoadedReview
      key={`${props.host.id}:${props.workspaceId}:${target.agentId}`}
      {...props}
      initial={query.data}
      current={query.data}
    />
  );
}
function useReviewModel(initial: ReviewState | null, current: ReviewState | null) {
  const [model] = useState(() => openReviewForm(initial));
  useEffect(() => {
    model.applyReview(current);
  }, [model, current]);
  useEffect(() => () => model.close(), [model]);
  return { model, state: useSyncExternalStore(model.subscribe, model.getState) };
}
function useReviewController({
  initial,
  current,
  ...props
}: PluginAgentPanelProps & { initial: ReviewState | null; current: ReviewState | null }) {
  const { model, state: form } = useReviewModel(initial, current);
  const settings = useSettings(preferences);
  const prepare = useRpc(prepareReview);
  const start = useRpc(startReview);
  const open = useRpc(openReview);
  const update = useRpc(updateReview);
  const cancel = useRpc(cancelReview);
  const retry = useRpc(retryReview);
  const agentGuide = useRpc(requestGuide);
  const cancelPending = useRpc(cancelGuide);
  const cache = useQueryClient();
  const target = { agentId: props.params.agentId, workspaceId: props.workspaceId };
  const queryKey = ["plannotator-review", props.host.id, props.workspaceId, target.agentId];
  const prepared = useQuery({
    queryKey: ["plannotator-prepare", ...queryKey, form.selection],
    queryFn: () => prepare({ ...target, selection: form.selection }),
    staleTime: 0,
  });
  const review = form.review;
  const revision = review?.revisions.find((item) => item.id === review.revisionId);
  const acknowledged =
    settings.status === "ready" && settings.values.autoViewedDisabledAcknowledged;
  const action = useMutation({
    mutationFn: async (intent: Intent) => {
      let result: ReviewState;
      if (intent.action === "start") result = await start({ ...target, selection: form.selection });
      else {
        if (!review) throw new Error("No review is available");
        const input = { ...target, reviewId: review.id, revisionId: review.revisionId };
        switch (intent.action) {
          case "open":
          case "native-guide":
            result = await open({ ...input, viewRevisionId: intent.id });
            break;
          case "update":
            result = await update({ ...input, selection: form.selection });
            break;
          case "cancel":
            result = await cancel(input);
            break;
          case "agent-guide":
            result = await agentGuide(input);
            break;
          case "cancel-guide":
            result = await cancelPending({ ...input, requestId: intent.id! });
            break;
          case "retry":
            result = await retry({ ...input, deliveryId: intent.id! });
            break;
        }
      }
      cache.setQueryData(queryKey, result);
      model.applyReview(result);
      if (["start", "open", "update", "native-guide"].includes(intent.action) && result.url)
        props.navigation?.openBrowser?.({
          url: result.url,
          workspaceId: props.workspaceId,
          serverId: props.host.id,
        });
      return result;
    },
  });
  const { mutate } = action;
  const selectMode = useCallback((mode: SourceSelection["mode"]) => model.setMode(mode), [model]);
  const selectBase = useCallback((base: string) => model.setBase(base), [model]);
  const acknowledge = useCallback(
    (value: boolean) => {
      if (settings.status === "ready")
        void settings.save({ autoViewedDisabledAcknowledged: value }, settings.revision);
    },
    [settings],
  );
  const checkUpdates = useCallback(() => {
    void prepared.refetch();
  }, [prepared]);
  const styles = useMemo(
    () => ({
      text: { color: props.theme.colors.foreground },
      muted: { color: props.theme.colors.foregroundMuted },
      error: { color: props.theme.colors.statusDanger },
      content: { padding: 20, gap: 14, backgroundColor: props.theme.colors.surface0 },
      row: { gap: 8 },
    }),
    [props.theme],
  );
  const baseOptions = useMemo(
    () => [
      { value: "", label: "Workspace / inherited / detected base" },
      ...(prepared.data?.refs ?? []),
    ],
    [prepared.data?.refs],
  );
  return {
    props,
    form,
    settings,
    prepared,
    review,
    revision,
    acknowledged,
    action,
    mutate,
    selectMode,
    selectBase,
    acknowledge,
    checkUpdates,
    styles,
    baseOptions,
  };
}
type Controller = ReturnType<typeof useReviewController>;
function LoadedReview(
  props: PluginAgentPanelProps & { initial: ReviewState | null; current: ReviewState | null },
) {
  const controller = useReviewController(props);
  return (
    <ScrollView contentContainerStyle={controller.styles.content}>
      <ReviewSetup controller={controller} />
      <ComparisonStatus controller={controller} />
      <ReviewControls controller={controller} />
      <ReviewProgress controller={controller} />
      <ReviewHistory controller={controller} />
      <ReviewDeliveries controller={controller} />
      <ReviewErrors controller={controller} />
    </ScrollView>
  );
}
function ReviewSetup({ controller: c }: { controller: Controller }) {
  const ready = c.prepared.data;
  return (
    <>
      <Text style={c.styles.text}>Plannotator · Code review</Text>
      <Text style={c.styles.muted}>
        Local daemon only · {ready?.workspaceName ?? c.props.workspaceId}
      </Text>
      <Text style={c.styles.text}>
        Feedback recipient: {ready?.agentName ?? c.props.params.agentId} ({c.props.params.agentId})
      </Text>
      <SettingsCard>
        <SettingsSelect
          label="Review source"
          value={c.form.selection.mode}
          options={modes}
          onValueChange={c.selectMode}
          disabled={c.action.isPending}
        />
        {c.form.selection.mode === "task" && (
          <SettingsSelect
            label="Comparison base"
            value={c.form.selection.baseRef ?? ""}
            options={c.baseOptions}
            onValueChange={c.selectBase}
            disabled={c.action.isPending || c.prepared.isPending}
          />
        )}
        <SettingsSwitch
          label="I disabled Auto-mark viewed in Plannotator"
          value={c.acknowledged}
          onValueChange={c.acknowledge}
          disabled={c.settings.status !== "ready" || c.settings.saving}
        />
      </SettingsCard>
      <Text style={c.styles.muted}>
        Before reading changes, open Plannotator Settings → Review and turn Auto-mark viewed off.
        This confirmation does not check the browser setting. Repeat after clearing browser data.
        You can open a review to configure Plannotator before confirming.
      </Text>
    </>
  );
}
function ComparisonStatus({ controller: c }: { controller: Controller }) {
  const resolved = c.prepared.data?.resolved;
  const changed =
    c.revision && resolved && JSON.stringify(c.revision.resolved) !== JSON.stringify(resolved);
  return (
    <>
      <Text style={c.styles.text}>
        Selected comparison: {resolved?.description ?? "Not resolved"}
      </Text>
      <Text style={c.styles.muted}>
        Base: {resolved?.baseRef ?? "not applicable"} · HEAD: {resolved?.headRevision ?? "unknown"}
      </Text>
      <PanelButton
        label="Check for updates"
        disabled={c.action.isPending || c.prepared.isFetching}
        onPress={c.checkUpdates}
        color={c.styles.text.color}
      />
      {changed && (
        <Text style={c.styles.text}>
          New comparison available. Reviewed HEAD: {c.revision?.resolved?.headRevision ?? "unknown"}
          ; available HEAD: {resolved.headRevision ?? "unknown"}. Use Update changes to create a
          snapshot.
        </Text>
      )}
      <Text style={c.styles.text}>
        Status: {c.review?.status ?? "ready"} · Open revision: {c.review?.liveRevisionId ?? "none"}
      </Text>
    </>
  );
}
function ReviewControls({ controller: c }: { controller: Controller }) {
  const busy = c.action.isPending;
  const disabled = busy || !c.acknowledged;
  if (!c.review)
    return (
      <IntentButton
        controller={c}
        action="start"
        label="Start review / configure Plannotator"
        disabled={busy || !c.prepared.data?.resolved}
      />
    );
  return (
    <>
      <Text style={c.styles.text}>
        Reviewing: {c.revision?.resolved?.description ?? "Legacy review"}
      </Text>
      <Text style={c.styles.muted}>
        Snapshot HEAD: {c.revision?.resolved?.headRevision ?? "unknown"} · {c.revision?.patchHash}
      </Text>
      <IntentButton controller={c} action="open" label="Open review" disabled={busy} />
      <IntentButton
        controller={c}
        action="update"
        label="Update changes"
        disabled={disabled || !c.prepared.data?.resolved}
      />
      <IntentButton
        controller={c}
        action="agent-guide"
        label="Guide from task agent"
        disabled={
          disabled ||
          c.prepared.data?.agentBusy ||
          c.revision?.guides.some((guide) => guide.status === "pending")
        }
      />
      {c.prepared.data?.agentBusy && (
        <Text style={c.styles.muted}>
          The original agent is busy. Request a Guide after its turn finishes.
        </Text>
      )}
      <IntentButton
        controller={c}
        action="native-guide"
        label="Guide through Plannotator"
        disabled={disabled}
      />
      <Text style={c.styles.muted}>
        In Plannotator, select Guide → Generate and choose your provider and model. Imported and
        generated Guides stay available in its Guide picker.
      </Text>
      <IntentButton
        controller={c}
        action="cancel"
        label="Stop review (keep saved state)"
        disabled={busy}
      />
    </>
  );
}
function ReviewProgress({ controller: c }: { controller: Controller }) {
  const id = c.review?.liveRevisionId ?? c.review?.revisionId;
  const revision = c.review?.revisions.find((item) => item.id === id);
  if (!revision) return null;
  return (
    <>
      <Text style={c.styles.text}>
        Files: {revision.draft?.viewedFiles?.length ?? 0} / {revision.files.length} · revision{" "}
        {revision.id}
      </Text>
      {revision.guides.map((guide) => (
        <GuideProgress key={guide.id} guide={guide} controller={c} />
      ))}
      <Text style={c.styles.muted}>
        Section marks can mark their files viewed. To resume saved comments and file marks, use
        Restore draft in Plannotator. The full file list remains available outside Guide.
      </Text>
    </>
  );
}
function GuideProgress({ guide, controller: c }: { guide: Guide; controller: Controller }) {
  return (
    <View style={c.styles.row}>
      <Text style={c.styles.text}>
        {guide.document?.title ?? "Preparing Guide"} · {guide.source} · {guide.status}
      </Text>
      <Text style={c.styles.muted}>
        Guide sections: {guide.reviewed.filter(Boolean).length} /{" "}
        {guide.document?.sections.length ?? 0} · Outside Guide: {guide.uncovered.length}
      </Text>
      {guide.uncovered.length > 0 && (
        <Text selectable style={c.styles.muted}>
          {guide.uncovered.join("\n")}
        </Text>
      )}
      {guide.error && <Text style={c.styles.error}>{guide.error}</Text>}
      {guide.status === "pending" && (
        <IntentButton
          controller={c}
          action="cancel-guide"
          id={guide.requestId ?? undefined}
          label="Cancel Guide request"
          disabled={c.action.isPending}
        />
      )}
    </View>
  );
}
function ReviewHistory({ controller: c }: { controller: Controller }) {
  if (!c.review || c.review.revisions.length < 2) return null;
  return (
    <>
      {c.review.revisions.map((item) => (
        <SavedRevision key={item.id} revision={item} controller={c} />
      ))}
    </>
  );
}
function SavedRevision({
  revision: item,
  controller: c,
}: {
  revision: Revision;
  controller: Controller;
}) {
  return (
    <View style={c.styles.row}>
      <Text style={c.styles.muted}>
        {item.createdAt} · {item.resolved?.headRevision ?? "legacy"} · {item.guides.length} Guides
        {item.id === c.review?.revisionId ? " (current)" : " (outdated for current snapshot)"}
      </Text>
      <IntentButton
        controller={c}
        action="open"
        id={item.id}
        label="Open saved revision"
        disabled={c.action.isPending || !item.patchPath}
      />
    </View>
  );
}
function ReviewDeliveries({ controller: c }: { controller: Controller }) {
  return (
    c.review?.deliveries.map((item) => (
      <SavedDelivery key={item.id} delivery={item} controller={c} />
    )) ?? null
  );
}
function SavedDelivery({
  delivery: item,
  controller: c,
}: {
  delivery: Delivery;
  controller: Controller;
}) {
  return (
    <View style={c.styles.row}>
      <Text style={c.styles.text}>
        Feedback: {item.status} · recipient {item.agentId}
      </Text>
      <Text selectable style={c.styles.text}>
        {item.text}
      </Text>
      {item.error && <Text style={c.styles.error}>{item.error}</Text>}
      {["failed", "unknown", "pending"].includes(item.status) && (
        <IntentButton
          controller={c}
          action="retry"
          id={item.id}
          label="Retry delivery — check original session for duplicates first"
          disabled={c.action.isPending}
        />
      )}
    </View>
  );
}
function ReviewErrors({ controller: c }: { controller: Controller }) {
  const errors = [
    c.action.error?.message,
    c.prepared.error?.message,
    c.prepared.data?.error,
    c.review?.error,
    c.settings.saveError,
  ];
  const settingsError =
    c.settings.status === "error" || c.settings.status === "invalid" ? c.settings.error : null;
  return (
    <>
      {[...new Set(errors)].filter(Boolean).map((error) => (
        <Text key={error} style={c.styles.error}>
          {error}
        </Text>
      ))}
      {settingsError && <Text style={c.styles.error}>{settingsError}</Text>}
    </>
  );
}
function IntentButton({
  controller: c,
  action,
  id,
  label,
  disabled,
}: {
  controller: Controller;
  action: Action;
  id?: string;
  label: string;
  disabled?: boolean;
}) {
  const { mutate } = c;
  const onPress = useCallback(() => mutate({ action, id }), [mutate, action, id]);
  return (
    <PanelButton label={label} disabled={disabled} onPress={onPress} color={c.styles.text.color} />
  );
}
function PanelButton({
  label,
  disabled,
  onPress,
  color,
}: {
  label: string;
  disabled?: boolean;
  onPress(): void;
  color: string;
}) {
  const style = useMemo(() => ({ color }), [color]);
  return (
    <Button disabled={disabled} onPress={onPress}>
      <Text style={style}>{label}</Text>
    </Button>
  );
}
