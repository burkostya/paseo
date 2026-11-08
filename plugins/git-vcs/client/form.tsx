import { useCallback, useMemo, useState, useSyncExternalStore } from "react";
import { Text } from "react-native";
import { useQuery } from "@tanstack/react-query";
import { usePaseo, useTranslation, type PluginVcsActionFormProps } from "@getpaseo/plugin/client";
import {
  Form,
  Field,
  FormTextInput,
  SelectField,
  SettingsSwitch,
  Button,
  type SelectFieldOption,
} from "@getpaseo/plugin/client/ui";
import { messages } from "./messages.js";
import { openGitActionForm, gitFormFields } from "./model.js";
import type { GitAction } from "../shared/actions.js";
type Model = ReturnType<typeof openGitActionForm>;
export function createGitActionForm(action: GitAction) {
  return function GitActionForm({
    context,
    pending,
    submit,
    layout,
    theme,
  }: PluginVcsActionFormProps) {
    const { t } = useTranslation(messages);
    const paseo = usePaseo();
    const [model] = useState(() => openGitActionForm(action, context));
    const state = useSyncExternalStore(model.subscribe, model.getState, model.getState);
    const fields = gitFormFields(action);
    const queryKey = useMemo(() => ["git-vcs-remotes", context.workspaceId], [context.workspaceId]);
    const remotes = useQuery({
      queryKey,
      enabled: fields.includes("remote"),
      staleTime: 30000,
      retry: false,
      queryFn: () => paseo.workspaces.ref(context.workspaceId).vcs.publication.remotes(),
    });
    const options = useMemo(
      () => ({
        remote: (remotes.data ?? []).map((remote) => ({
          id: remote.name,
          value: remote.name,
          label: remote.name,
        })),
        name: context.snapshot.refs
          .filter((ref) => ref.kind === "branch")
          .map((ref) => ({ id: ref.id, value: ref.name, label: ref.name })),
        revision: context.revisions.map((revision) => ({
          id: revision.id,
          value: revision.id,
          label: `${revision.id.slice(0, 12)} · ${revision.description.trim().split("\n")[0]}`,
        })),
        message: [],
      }),
      [context.revisions, context.snapshot.refs, remotes.data],
    );
    const apply = useCallback(() => {
      void submit(state.input);
    }, [submit, state.input]);
    const style = useMemo(
      () => ({ color: theme.colors.statusDanger }),
      [theme.colors.statusDanger],
    );
    return (
      <Form>
        {fields.map((field) => (
          <GitField
            key={field}
            field={field}
            action={action}
            model={model}
            value={state[field]}
            pending={pending}
            size={layout.compact ? "md" : "sm"}
            options={options[field]}
          />
        ))}
        {action === "commit" ? (
          <SettingsSwitch
            label={t("all")}
            value={state.all}
            onValueChange={model.setAll}
            disabled={pending}
            testID="git-commit-all"
          />
        ) : null}
        {["stage", "unstage", "discard", "restore"].includes(action) ? (
          <Field label={t("fields.files")}>
            {model.candidates.map((file) => (
              <FileChoice
                key={file}
                file={file}
                model={model}
                selected={state.files.includes(file)}
                pending={pending}
              />
            ))}
          </Field>
        ) : null}
        {remotes.error ? (
          <Text style={style} accessibilityRole="alert">
            {remotes.error.message}
          </Text>
        ) : null}
        {!state.valid ? <Text style={style}>{t("invalid")}</Text> : null}
        <Button
          testID="vcs-action-submit"
          disabled={pending || !state.valid}
          loading={pending}
          onPress={apply}
        >
          {t("apply")}
        </Button>
      </Form>
    );
  };
}
function FileChoice({
  file,
  model,
  selected,
  pending,
}: {
  file: string;
  model: Model;
  selected: boolean;
  pending: boolean;
}) {
  const change = useCallback(() => model.toggleFile(file), [file, model]);
  return (
    <SettingsSwitch
      label={file}
      value={selected}
      onValueChange={change}
      disabled={pending}
      testID={`git-file-${file}`}
    />
  );
}
function GitField(props: {
  field: "message" | "name" | "remote" | "revision";
  value: string;
  action: GitAction;
  model: Model;
  pending: boolean;
  size: "sm" | "md";
  options: SelectFieldOption<string>[];
}) {
  const { t } = useTranslation(messages);
  const change = useCallback(
    (value: string) => props.model.set(props.field, value),
    [props.model, props.field],
  );
  const display = useMemo(
    () =>
      props.value
        ? { label: props.options.find((item) => item.value === props.value)?.label ?? props.value }
        : null,
    [props.options, props.value],
  );
  const label = t(`fields.${props.field}`);
  if (props.field === "message" || (props.field === "name" && props.action === "branch-create"))
    return (
      <Field label={label}>
        <FormTextInput
          initialValue={props.value}
          onChangeText={change}
          multiline={props.field === "message"}
          editable={!props.pending}
          size={props.size}
          testID={`git-${props.field}`}
        />
      </Field>
    );
  return (
    <SelectField
      label={label}
      value={props.value || null}
      selectedDisplay={display}
      onChange={change}
      options={props.options}
      placeholder={t("choose")}
      emptyText={t("empty")}
      disabled={props.pending}
      size={props.size}
      testID={`git-${props.field}`}
    />
  );
}
