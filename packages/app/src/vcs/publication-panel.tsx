import { useCallback, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { useMutation } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  VcsPublicationResultSchema,
  type VcsSnapshot,
  type VcsPublication,
  type VcsChangeRequest,
} from "@getpaseo/protocol/vcs";
import { Button } from "@/components/ui/button";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { SelectField, type SelectFieldOption } from "@/components/ui/select-field";
import { ScrollView } from "@/components/ui/scroll-view";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useFetchQuery } from "@/data/query";
import { useHostFeature } from "@/runtime/host-features";
import { confirmDialog } from "@/utils/confirm-dialog";
import { openExternalUrl } from "@/utils/open-external-url";
import { useWorkspaceVcs, vcsQueryKey } from "./queries";
import { openPublicationForm } from "./publication-model";
import { usePublicationForm } from "./use-publication-form";
import {
  matchesPublicationSelection,
  publicationIdentity,
  publicationStatusView,
} from "./publication-state";
import { Form } from "./form";
import { vcsStyles as styles } from "./styles";
import type { VcsPaneState, VcsOperationRequest } from "./state";
import type { useVcsOperation } from "./use-operation";
interface Props {
  serverId: string;
  workspaceId: string;
  snapshot: VcsSnapshot;
  state: VcsPaneState;
  setState(state: VcsPaneState): void;
  active: boolean;
  operation: ReturnType<typeof useVcsOperation>;
}
type Model = ReturnType<typeof openPublicationForm>;
type State = ReturnType<Model["getState"]>;
type PublicationRequest = Extract<VcsOperationRequest, { kind: "publication" }>;
function lastPublication(request?: VcsOperationRequest): PublicationRequest | null {
  return request?.kind === "publication" ? request : null;
}
export function VcsPublicationPanel(props: Props) {
  const { t } = useTranslation();
  const supported = useHostFeature(props.serverId, "vcsPublication");
  return supported ? (
    <Publication
      key={JSON.stringify([
        props.serverId,
        props.workspaceId,
        publicationIdentity(props.snapshot.binding),
      ])}
      {...props}
    />
  ) : (
    <Text style={styles.error}>{t("vcs.updateHost")}</Text>
  );
}
function Publication(props: Props) {
  const { t } = useTranslation();
  const { vcs, connected, identity } = useWorkspaceVcs(props.serverId, props.workspaceId);
  const { model, state } = usePublicationForm({
    state: props.state,
    setState: props.setState,
    identity: publicationIdentity(props.snapshot.binding),
  });
  const inspect = useCallback(() => {
    if (vcs)
      void model.lookup((selection) =>
        vcs.publication.resolve(selection, props.snapshot.binding.providerId),
      );
  }, [model, vcs, props.snapshot.binding.providerId]);
  const size = useIsCompactFormFactor() ? "md" : "sm";
  const remotes = useFetchQuery({
    dataShape: "list",
    staleTimeMs: 30_000,
    queryKey: [
      ...vcsQueryKey(props.serverId, props.workspaceId),
      "remotes",
      ...identity,
      props.snapshot.binding,
    ],
    enabled: props.active && connected && !!vcs,
    retry: false,
    queryFn: () => {
      if (!vcs) throw new Error("Host is unavailable");
      return vcs.publication.remotes(props.snapshot.binding.providerId);
    },
  });
  const create = useMutation({
    mutationFn: async () => {
      if (!vcs) throw new Error("Host is unavailable");
      const target = await vcs.publication.resolve(
        {
          remote: state.remote,
          headRef: state.headRef,
          baseRef: state.baseRef.trim(),
        },
        props.snapshot.binding.providerId,
      );
      if (
        !(await confirmDialog({
          title: t("vcs.createRequest"),
          message: `${target.remote} · ${target.headRef}\n${target.headRevision}\n→ ${target.baseRef}`,
          confirmLabel: t("vcs.createRequest"),
          cancelLabel: t("common.cancel"),
        }))
      )
        return;
      await props.operation.start(props.snapshot.binding.providerId, {
        kind: "publication",
        target,
        input: { action: "create", title: state.title, body: state.body, publish: true },
      });
    },
  });
  const { mutate: createRequest } = create;
  const submit = useCallback(() => createRequest(), [createRequest]);
  const choices = useMemo(
    () => ({
      remote: (remotes.data ?? []).map((remote) => ({
        id: remote.name,
        value: remote.name,
        label: remote.name,
      })),
      headRef: props.snapshot.refs
        .filter((ref) => ref.publishable)
        .map((ref) => ({ id: ref.id, value: ref.name, label: ref.name })),
    }),
    [remotes.data, props.snapshot.refs],
  );
  const disabled =
    !connected || props.operation.pending || create.isPending || state.lookup.status === "pending";
  const last = lastPublication(props.state.operation?.request);
  const target = inspectedPublication(state, last);
  return (
    <ScrollView contentContainerStyle={styles.scrollContent}>
      <Form>
        {remotes.error || create.error || state.lookup.status === "failed" ? (
          <Text accessibilityRole="alert" style={styles.error}>
            {(remotes.error ?? create.error)?.message ??
              (state.lookup.status === "failed" ? state.lookup.message : "")}
          </Text>
        ) : null}
        <PublicationSelect
          label={t("vcs.remote")}
          field="remote"
          model={model}
          state={state}
          options={choices.remote}
          disabled={disabled || remotes.isPending}
          size={size}
        />
        <PublicationSelect
          label={t("vcs.headRef")}
          field="headRef"
          model={model}
          state={state}
          options={choices.headRef}
          disabled={disabled}
          size={size}
        />
        <PublicationInput
          label={t("vcs.baseRef")}
          field="baseRef"
          model={model}
          state={state}
          disabled={disabled}
          size={size}
        />
        <PublicationInput
          label={t("vcs.requestTitle")}
          field="title"
          model={model}
          state={state}
          disabled={disabled}
          size={size}
        />
        <PublicationInput
          label={t("vcs.body")}
          field="body"
          model={model}
          state={state}
          disabled={disabled}
          size={size}
        />
        <Button
          variant="default"
          disabled={disabled || !state.canSubmit}
          loading={create.isPending}
          onPress={submit}
          testID="vcs-create-request"
        >
          {t("vcs.createRequest")}
        </Button>
        <Button
          variant="outline"
          disabled={disabled || !state.canLookup}
          loading={state.lookup.status === "pending"}
          onPress={inspect}
          testID="vcs-find-request"
        >
          {t("vcs.findRequest")}
        </Button>
        <RetryPublication {...props} disabled={disabled} request={last} />
        {target ? (
          <PublicationStatus
            {...props}
            key={JSON.stringify(target)}
            target={target}
            lookupVersion={state.lookupVersion}
            disabled={disabled}
          />
        ) : null}
      </Form>
    </ScrollView>
  );
}
function PublicationInput(props: {
  label: string;
  field: "baseRef" | "title" | "body";
  model: Model;
  state: State;
  disabled: boolean;
  size: "sm" | "md";
}) {
  const change = useCallback(
    (value: string) => props.model.set(props.field, value),
    [props.model, props.field],
  );
  return (
    <Field label={props.label}>
      <FormTextInput
        initialValue={props.state[props.field]}
        onChangeText={change}
        multiline={props.field === "body"}
        editable={!props.disabled}
        size={props.size}
        testID={`vcs-publish-${props.field === "baseRef" ? "base" : props.field}`}
      />
    </Field>
  );
}
function PublicationSelect(props: {
  label: string;
  field: "remote" | "headRef";
  model: Model;
  state: State;
  options: SelectFieldOption<string>[];
  disabled: boolean;
  size: "sm" | "md";
}) {
  const change = useCallback(
    (value: string, display: { label: string }) =>
      props.model.set(props.field, value, display.label),
    [props.model, props.field],
  );
  const displayLabel = props.field === "remote" ? props.state.remoteLabel : props.state.headLabel;
  const display = useMemo(
    () => (props.state[props.field] ? { label: displayLabel } : null),
    [props.state, props.field, displayLabel],
  );
  return (
    <SelectField
      label={props.label}
      value={props.state[props.field] || null}
      selectedDisplay={display}
      options={props.options}
      onChange={change}
      placeholder={props.label}
      emptyText="—"
      disabled={props.disabled}
      size={props.size}
      testID={`vcs-publish-${props.field === "remote" ? "remote" : "head"}`}
    />
  );
}
function RetryPublication(
  props: Props & { request: PublicationRequest | null; disabled: boolean },
) {
  const { t } = useTranslation();
  const mutation = useMutation({
    mutationFn: async () => {
      if (props.request?.input.action !== "create") return;
      await props.operation.start(props.snapshot.binding.providerId, {
        ...props.request,
        input: { ...props.request.input, publish: false },
      });
    },
  });
  const { mutate: retryRequest } = mutation;
  const submit = useCallback(() => retryRequest(), [retryRequest]);
  const result = VcsPublicationResultSchema.safeParse(props.operation.operation?.result);
  if (
    props.operation.operation?.status !== "failed" ||
    !result.success ||
    result.data.stage !== "published" ||
    props.request?.input.action !== "create"
  )
    return null;
  return (
    <View style={styles.form} testID="vcs-published-retry">
      <Text style={styles.text}>{t("vcs.published")}</Text>
      <Text style={styles.muted}>
        {props.request.input.title} · {props.request.target.headRef} ·{" "}
        {props.request.target.headRevision.slice(0, 12)}
      </Text>
      {mutation.error ? <Text style={styles.error}>{mutation.error.message}</Text> : null}
      <Button
        variant="outline"
        disabled={props.disabled || mutation.isPending}
        onPress={submit}
        testID="vcs-retry-create"
      >
        {t("vcs.retryCreate")}
      </Button>
    </View>
  );
}
type ForgeAction = "merge" | "enable-auto-merge" | "disable-auto-merge";
type MergeMethod = "merge" | "squash" | "rebase";
const methods: SelectFieldOption<MergeMethod>[] = [
  { id: "merge", value: "merge", label: "merge" },
  { id: "squash", value: "squash", label: "squash" },
  { id: "rebase", value: "rebase", label: "rebase" },
];
const actionLabels = {
  merge: "vcs.merge",
  "enable-auto-merge": "vcs.enableAutoMerge",
  "disable-auto-merge": "vcs.disableAutoMerge",
} as const;
function PublicationStatus(
  props: Props & { target: VcsPublication; disabled: boolean; lookupVersion: number },
) {
  const { t } = useTranslation();
  const { vcs, connected, identity } = useWorkspaceVcs(props.serverId, props.workspaceId);
  const [method, setMethod] = useState<MergeMethod>("squash");
  const [error, setError] = useState<string | null>(null);
  const display = useMemo(() => ({ label: method }), [method]);
  const query = useFetchQuery({
    dataShape: "value",
    staleTimeMs: 30_000,
    queryKey: [
      ...vcsQueryKey(props.serverId, props.workspaceId),
      "publication-status",
      ...identity,
      props.target,
      props.lookupVersion,
      props.operation.operation?.status,
      props.state.operation?.id,
    ],
    enabled: props.active && connected && !!vcs && !props.operation.pending,
    retry: false,
    queryFn: () => {
      if (!vcs) throw new Error("Host is unavailable");
      return vcs.publication.status(props.target, props.snapshot.binding.providerId);
    },
  });
  const { status, requestUrl, empty } = publicationStatusView({
    data: query.data,
    error: query.error,
    isPending: query.isPending,
    result: props.operation.operation?.result,
    target: props.target,
  });
  const { refetch } = query;
  const { start } = props.operation;
  const refresh = useCallback(() => {
    void refetch();
  }, [refetch]);
  const disabled = props.disabled || query.isFetching || !!query.error;
  const open = useCallback(() => {
    if (requestUrl)
      void openExternalUrl(requestUrl).catch((failure: unknown) => setError(String(failure)));
  }, [requestUrl]);
  const execute = useCallback(
    async (action: ForgeAction) => {
      if (!status?.number) return;
      setError(null);
      try {
        if (
          !(await confirmDialog({
            title: t(actionLabels[action]),
            message: `${status.title}\n${status.url}\n${props.target.headRevision}`,
            cancelLabel: t("common.cancel"),
          }))
        )
          return;
        const input =
          action === "disable-auto-merge"
            ? { action, number: status.number, url: status.url }
            : { action, number: status.number, url: status.url, mergeMethod: method };
        await start(props.snapshot.binding.providerId, {
          kind: "publication",
          target: props.target,
          input,
        });
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : String(failure));
      }
    },
    [status, t, props.target, start, props.snapshot.binding.providerId, method],
  );
  const checks = useMemo(() => keyedChecks(status?.checks ?? []), [status?.checks]);
  return (
    <View style={styles.form} testID="vcs-publication-status">
      {query.error || error ? (
        <Text style={styles.error} accessibilityRole="alert">
          {query.error?.message ?? error}
        </Text>
      ) : null}
      <Button variant="ghost" disabled={!connected || query.isFetching} onPress={refresh}>
        {t("vcs.refresh")}
      </Button>
      {requestUrl ? (
        <Button variant="outline" onPress={open} testID="vcs-open-request">
          {t("vcs.openRequest")}
        </Button>
      ) : null}
      {status ? (
        <>
          <Text style={styles.text}>
            {status.title} · {status.state}
          </Text>

          {checks.map(({ key, check }) => (
            <Text key={key} style={styles.muted}>
              {check.name} · {check.status}
            </Text>
          ))}
          {status.state.toLowerCase() === "open" && status.number ? (
            <>
              <SelectField
                label={t("vcs.mergeMethod")}
                value={method}
                selectedDisplay={display}
                options={methods}
                onChange={setMethod}
                placeholder={t("vcs.mergeMethod")}
                emptyText=""
                disabled={props.disabled}
              />
              <ForgeActionButton action="merge" disabled={disabled} execute={execute} />
              <ForgeActionButton action="enable-auto-merge" disabled={disabled} execute={execute} />
              <ForgeActionButton
                action="disable-auto-merge"
                disabled={disabled}
                execute={execute}
              />
            </>
          ) : null}
        </>
      ) : null}
      {empty ? (
        <Text style={styles.muted} testID="vcs-no-request">
          {t("vcs.noRequest")}
        </Text>
      ) : null}
    </View>
  );
}
function inspectedPublication(
  state: State,
  last: PublicationRequest | null,
): VcsPublication | null {
  if (state.target) return state.target;
  return state.lookup.status === "idle" &&
    state.lookupVersion === 0 &&
    last &&
    matchesPublicationSelection(state, last.target)
    ? last.target
    : null;
}
function keyedChecks(checks: VcsChangeRequest["checks"]) {
  const counts = new Map<string, number>();
  return checks.map((check) => {
    const identity = JSON.stringify([check.checkRunId, check.workflowRunId, check.name, check.url]);
    const occurrence = counts.get(identity) ?? 0;
    counts.set(identity, occurrence + 1);
    return { key: `${identity}:${occurrence}`, check };
  });
}
function ForgeActionButton(props: {
  action: ForgeAction;
  disabled: boolean;
  execute(action: ForgeAction): Promise<void>;
}) {
  const { t } = useTranslation();
  const { execute: onExecute } = props;
  const execute = useCallback(() => {
    void onExecute(props.action);
  }, [onExecute, props.action]);
  return (
    <Button variant="ghost" disabled={props.disabled} onPress={execute}>
      {t(actionLabels[props.action])}
    </Button>
  );
}
