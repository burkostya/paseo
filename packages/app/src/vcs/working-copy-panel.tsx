import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Text } from "react-native";
import { useTranslation } from "react-i18next";
import { v4 as uuid } from "uuid";
import type { VcsRevision, VcsSnapshot } from "@getpaseo/protocol/vcs";
import { useWorkspace } from "@/stores/session-store-hooks";
import { normalizeWorkspaceDescriptor, useSessionStore } from "@/stores/session-store";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useIsCompactFormFactor } from "@/constants/layout";
import { Button } from "@/components/ui/button";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { SelectField } from "@/components/ui/select-field";
import { ScrollView } from "@/components/ui/scroll-view";
import { Form } from "./form";
import { vcsStyles as styles } from "./styles";
import { selectionRevision } from "./selection";
import {
  openWorkingCopyForm,
  workingCopyIdentity,
  workingCopyRevisionLabel,
  type WorkingCopyDraft,
} from "./working-copy-model";
import type { VcsPaneState } from "./state";
import { VcsWorkingCopyFields, useWorkingCopyValidator } from "./working-copy-fields";

interface Props {
  serverId: string;
  workspaceId: string;
  snapshot: VcsSnapshot;
  revisions: VcsRevision[];
  state: VcsPaneState;
  setState(state: VcsPaneState): void;
  pending: boolean;
  hasMore: boolean;
  loadMore(): void;
  historyError?: string;
  loadingMore: boolean;
}
export function VcsWorkingCopyPanel(props: Props) {
  const { t } = useTranslation();
  const supported = useHostFeature(props.serverId, "vcsWorkingCopySelection");
  const workspace = useWorkspace(props.serverId, props.workspaceId);
  if (!supported) return <Text style={styles.error}>{t("vcs.updateHost")}</Text>;
  if (!workspace) return null;
  return (
    <WorkingCopyForm
      key={workingCopyIdentity(workspace.projectId, props.snapshot.binding)}
      {...props}
      projectId={workspace.projectId}
    />
  );
}
function WorkingCopyForm(props: Props & { projectId: string }) {
  const { t } = useTranslation();
  const client = useHostRuntimeClient(props.serverId);
  const connected = useHostRuntimeIsConnected(props.serverId);
  const validate = useWorkingCopyValidator(props.serverId, props.snapshot);
  const size = useIsCompactFormFactor() ? "md" : "sm";
  const [model] = useState(() =>
    openWorkingCopyForm({
      projectId: props.projectId,
      binding: props.snapshot.binding,
      revision: selectionRevision(props.state.selection, props.snapshot),
      saved: props.state.workingCopy,
    }),
  );
  const state = useSyncExternalStore(model.subscribe, model.getState, model.getState);
  const { state: pane, setState } = props;
  useEffect(
    () => model.subscribe(() => setState({ ...pane, workingCopy: model.getState() })),
    [model, pane, setState],
  );
  useEffect(() => () => model.close(), [model]);
  const revisions = useMemo(() => {
    const selected = selectionRevision(props.state.selection, props.snapshot);
    return [
      ...new Map(
        [
          ...(selected ? [selected] : []),
          ...(props.snapshot.current ? [props.snapshot.current] : []),
          ...props.revisions,
        ].map((revision) => [revision.id, revision]),
      ).values(),
    ];
  }, [props.state.selection, props.snapshot, props.revisions]);
  const options = useMemo(
    () =>
      revisions.map((revision) => ({
        id: revision.id,
        value: revision.id,
        label: workingCopyRevisionLabel(revision),
      })),
    [revisions],
  );
  const display = useMemo(
    () => (state.revision ? { label: state.revisionLabel } : null),
    [state.revision, state.revisionLabel],
  );
  const choose = useCallback(
    (id: string) => {
      const revision = revisions.find((item) => item.id === id);
      if (revision) model.selectRevision(revision);
    },
    [model, revisions],
  );
  const submit = useCallback(() => {
    if (!client) return;
    void model.submit({
      id: uuid,
      validate,
      create: async (request) => {
        const response = await client.createWorkspace(request);
        if (response.workspace)
          useSessionStore
            .getState()
            .mergeWorkspaces(props.serverId, [normalizeWorkspaceDescriptor(response.workspace)]);
        if (!response.workspace && !response.error)
          throw new Error("Missing workspace creation result");
        return { workspaceId: response.workspace?.id ?? null, error: response.error ?? null };
      },
    });
  }, [client, model, props.serverId, validate]);
  const open = useCallback(() => {
    if (state.workspaceId)
      navigateToWorkspace({ serverId: props.serverId, workspaceId: state.workspaceId });
  }, [props.serverId, state.workspaceId]);
  const available = props.snapshot.actions.find((action) => action.id === "working-copy.create");
  const busy = props.pending || !connected || state.status === "pending";
  return (
    <ScrollView contentContainerStyle={styles.scrollContent}>
      <Form>
        <Field label={t("vcs.copyTitle")}>
          <FormTextInput
            key={state.intent?.idempotencyKey ?? "draft"}
            initialValue={state.title}
            onChangeText={model.setTitle}
            editable={!busy && !state.intent}
            size={size}
            testID="vcs-copy-title"
          />
        </Field>
        <SelectField
          label={t("vcs.copyRevision")}
          value={state.revision || null}
          selectedDisplay={display}
          options={options}
          onChange={choose}
          placeholder={t("vcs.copyRevision")}
          emptyText="—"
          disabled={busy || !!state.intent}
          size={size}
          testID="vcs-copy-revision"
        />
        {props.hasMore ? (
          <Button onPress={props.loadMore} disabled={props.loadingMore || !!state.intent}>
            {t("vcs.loadMore")}
          </Button>
        ) : null}
        <VcsWorkingCopyFields
          serverId={props.serverId}
          snapshot={props.snapshot}
          revision={state.revision}
          value={state.providerData}
          disabled={busy || !!state.intent}
          onChange={model.setProviderData}
        />
        {props.historyError ? (
          <Text accessibilityRole="alert" style={styles.error}>
            {props.historyError}
          </Text>
        ) : null}
        {!available?.enabled && !state.intent ? (
          <Text style={styles.muted}>{available?.reason ?? t("vcs.actionUnavailable")}</Text>
        ) : null}
        <CreationResult
          state={state}
          busy={busy}
          available={!!available?.enabled}
          size={size}
          submit={submit}
          open={open}
          reset={model.reset}
        />
      </Form>
    </ScrollView>
  );
}

function CreationResult({
  state,
  busy,
  available,
  size,
  submit,
  open,
  reset,
}: {
  state: WorkingCopyDraft;
  busy: boolean;
  available: boolean;
  size: "sm" | "md";
  submit(): void;
  open(): void;
  reset(): void;
}) {
  const { t } = useTranslation();
  return (
    <>
      {state.error ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {state.error}
        </Text>
      ) : null}
      {state.status === "pending" ? <Text style={styles.text}>{t("vcs.copyCreating")}</Text> : null}
      {state.status === "unknown" ? <Text style={styles.text}>{t("vcs.copyUnknown")}</Text> : null}
      {state.status === "succeeded" ? (
        <Text style={styles.text} testID="vcs-copy-success">
          {t("vcs.copyCreated")}
        </Text>
      ) : null}
      {state.status === "idle" || state.status === "unknown" ? (
        <Button
          size={size}
          testID="vcs-copy-create"
          onPress={submit}
          disabled={
            busy ||
            !state.revision ||
            state.title.trim().length > 200 ||
            (state.status === "idle" && !available)
          }
        >
          {t(state.status === "unknown" ? "vcs.copyCheckResult" : "vcs.createWorkingCopy")}
        </Button>
      ) : null}
      {state.workspaceId ? (
        <Button onPress={open} testID="vcs-copy-open">
          {t("vcs.copyOpen")}
        </Button>
      ) : null}
      {state.status === "succeeded" || state.status === "failed" ? (
        <Button variant="outline" onPress={reset}>
          {t("vcs.copyAnother")}
        </Button>
      ) : null}
    </>
  );
}
