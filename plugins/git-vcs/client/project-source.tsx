import { resolvedSource } from "../shared/working-copy.js";
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { View } from "react-native";
import {
  usePaseo,
  useTranslation,
  type PluginVcsProjectSourceProps,
} from "@getpaseo/plugin/client";
import { Field, SelectField, FormTextInput, Button } from "@getpaseo/plugin/client/ui";
import { openProjectSource } from "./project-source-model.js";
import { messages } from "./messages.js";

const containerStyle = { gap: 8 };

export function ProjectSource(props: PluginVcsProjectSourceProps) {
  const { t } = useTranslation(messages);
  const paseo = usePaseo();
  const [model] = useState(() =>
    openProjectSource({
      ...props,
      resolve: async (selection) =>
        resolvedSource.parse(
          await paseo.projects.vcs.resolveWorkingCopySource(props.context.projectId, {
            providerId: props.context.snapshot.binding.providerId,
            input: { version: 1, data: selection },
          }),
        ),
    }),
  );
  const [open, setOpen] = useState(false);
  const state = useSyncExternalStore(model.subscribe, model.getState, model.getState);
  useEffect(() => {
    model.activate(props.onChange);
  }, [model, props.onChange]);
  useEffect(() => () => model.close(), [model]);
  useEffect(
    () => model.applyChangeRequest(props.context.changeRequest),
    [model, props.context.changeRequest],
  );
  useEffect(() => {
    if (!open) return;
    const timer = setTimeout(() => {
      void model.search(async (query) => {
        const result = await paseo.forge.search({
          cwd: props.context.snapshot.binding.cwd,
          query,
          kinds: ["change_request"],
          limit: 50,
        });
        if (result.error) throw new Error(result.error);
        if (result.authState === "unauthenticated") throw new Error(t("sourceAuthRequired"));
        return result.items;
      });
    }, 250);
    return () => clearTimeout(timer);
  }, [model, paseo, props.context.snapshot.binding.cwd, t, open, state.query]);
  const select = useCallback((id: string) => model.select(id), [model]);
  const size = props.layout.compact ? "md" : "sm";
  let branchError: string | null = null;
  if (state.invalidBranch) branchError = t("workingCopyInvalid");
  if (state.branchExists) branchError = t("sourceBranchExists");
  const selectedDisplay = useMemo(
    () =>
      state.selected
        ? { label: state.selected.label, description: state.selected.request?.url }
        : null,
    [state.selected],
  );
  const options = useMemo(
    () =>
      state.options.map((option) => ({
        ...option,
        value: option.id,
        testID: option.request
          ? `new-workspace-ref-picker-pr-${option.request.number}`
          : `new-workspace-ref-picker-branch-${option.label}`,
      })),
    [state.options],
  );
  return (
    <View style={containerStyle}>
      <SelectField
        label={t("source")}
        value={state.selected?.id ?? null}
        selectedDisplay={selectedDisplay}
        options={options}
        onChange={select}
        placeholder={t("choose")}
        emptyText={t("empty")}
        searchable
        searchPlaceholder={t("sourceSearch")}
        onSearchQueryChange={model.setQuery}
        onOpenChange={setOpen}
        error={state.preparation.status === "error" ? state.preparation.message : state.error}
        loading={state.loading || state.preparation.status === "pending"}
        disabled={props.disabled}
        size={size}
        testID="git-project-source"
        triggerTestID="new-workspace-ref-picker-trigger"
      />
      {state.preparation.status === "error" ? (
        <Button onPress={model.retrySource} disabled={props.disabled}>
          {t("sourceRetry")}
        </Button>
      ) : null}
      {!state.selected?.request ? (
        <Field label={t("workingCopyBranch")} error={branchError}>
          <FormTextInput
            initialValue={state.branch}
            onChangeText={model.setBranch}
            editable={!props.disabled}
            size={size}
            testID="git-working-copy-branch"
          />
        </Field>
      ) : null}
    </View>
  );
}
