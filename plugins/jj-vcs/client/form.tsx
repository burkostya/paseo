import { useCallback, useMemo, useState, useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import { Text } from "react-native";
import { usePaseo, useTranslation, type PluginVcsActionFormProps } from "@getpaseo/plugin/client";
import {
  Field,
  Form,
  FormActions,
  FormTextInput,
  SelectField,
  SettingsSwitch,
  Button,
  type SelectFieldOption,
} from "@getpaseo/plugin/client/ui";
import { messages } from "./messages.js";
import { openJjActionForm, jjFormFields, type JjField } from "./model.js";
import type { JjAction } from "../shared/actions.js";
type Model = ReturnType<typeof openJjActionForm>;
type State = ReturnType<Model["getState"]>;
export function createJjActionForm(action: JjAction) {
  return function JjActionForm({
    context,
    pending,
    submit,
    theme,
    layout,
  }: PluginVcsActionFormProps) {
    const { t } = useTranslation(messages);
    const paseo = usePaseo();
    const [model] = useState(() => openJjActionForm(action, context));
    const state = useSyncExternalStore(model.subscribe, model.getState, model.getState);
    const fields = jjFormFields(action);
    const queryKey = useMemo(() => ["vcs-remotes", context.workspaceId], [context.workspaceId]);
    const remotes = useQuery({
      queryKey,
      enabled: fields.includes("remote"),
      staleTime: 30_000,
      retry: false,
      queryFn: () => paseo.workspaces.ref(context.workspaceId).vcs.publication.remotes(),
    });
    const size = layout.compact ? "md" : "sm";
    const choices = useMemo(
      () => ({
        revisions: context.revisions.map((revision) => ({
          id: revision.id,
          value: revision.id,
          label: `${revision.changeId?.slice(0, 12) ?? revision.id.slice(0, 12)} · ${revision.description.trim().split("\n")[0] || revision.id.slice(0, 12)}`,
        })),
        name: context.snapshot.refs
          .filter((ref) => {
            if (action === "bookmark-track") return ref.remote === state.remote;
            if (action === "bookmark-delete" || action === "bookmark-set") return !ref.remote;
            return ref.publishable;
          })
          .map((ref) => ({ id: ref.id, value: ref.name, label: ref.name })),
        remote: (remotes.data ?? []).map((remote) => ({
          id: remote.name,
          value: remote.name,
          label: remote.name,
        })),
      }),
      [state.remote, context.revisions, context.snapshot.refs, remotes.data],
    );
    const errorStyle = useMemo(
      () => ({ color: theme.colors.statusDanger }),
      [theme.colors.statusDanger],
    );
    const apply = useCallback(() => {
      void submit(state.input);
    }, [submit, state.input]);
    return (
      <Form>
        {fields.map((field) => (
          <JjFieldControl
            key={field}
            field={field}
            action={action}
            model={model}
            state={state}
            options={choices[field === "name" || field === "remote" ? field : "revisions"]}
            pending={pending}
            size={size}
          />
        ))}
        {remotes.error ? (
          <Text style={errorStyle} accessibilityRole="alert">
            {remotes.error.message}
          </Text>
        ) : null}
        {action === "new" ? (
          <Field label={t("fields.parents")}>
            <FormActions>
              {state.parents.map((parent) => (
                <Parent key={parent} id={parent} model={model} pending={pending} />
              ))}
            </FormActions>
            <SelectField
              label={t("addParent")}
              value={null}
              selectedDisplay={null}
              options={choices.revisions}
              onChange={model.addParent}
              placeholder={t("addParent")}
              emptyText={t("empty")}
              disabled={pending}
              size={size}
            />
          </Field>
        ) : null}
        {hasFiles(action) ? (
          <Field label={t("fields.files")}>
            {context.files.map((file) => (
              <FileChoice
                key={file}
                file={file}
                selected={state.files.includes(file)}
                model={model}
                pending={pending}
              />
            ))}
          </Field>
        ) : null}
        {!state.valid ? <Text style={errorStyle}>{t("invalid")}</Text> : null}
        <Button
          variant="default"
          disabled={pending || !state.valid}
          loading={pending}
          onPress={apply}
          testID="vcs-action-submit"
        >
          {t("apply")}
        </Button>
      </Form>
    );
  };
}
function hasFiles(action: JjAction) {
  return action === "squash" || action === "split" || action === "restore";
}
function JjFieldControl(props: {
  field: JjField;
  action: JjAction;
  model: Model;
  state: State;
  options: SelectFieldOption<string>[];
  pending: boolean;
  size: "sm" | "md";
}) {
  const { t } = useTranslation(messages);
  const change = useCallback(
    (value: string) => props.model.set(props.field, value),
    [props.model, props.field],
  );
  const value = props.state[props.field];
  const display = useMemo(
    () =>
      value ? { label: props.options.find((item) => item.value === value)?.label ?? value } : null,
    [value, props.options],
  );
  const label = t(`fields.${props.field}`);
  if (props.field === "message" || (props.field === "name" && props.action === "bookmark-create"))
    return (
      <Field label={label}>
        <FormTextInput
          initialValue={value}
          onChangeText={change}
          multiline={props.field === "message"}
          editable={!props.pending}
          size={props.size}
          testID={`jj-${props.field}`}
        />
      </Field>
    );
  return (
    <SelectField
      label={label}
      value={value || null}
      selectedDisplay={display}
      options={props.options}
      onChange={change}
      placeholder={t("choose")}
      emptyText={t("empty")}
      disabled={props.pending || (props.field === "revision" && props.state.revision !== "")}
      size={props.size}
      testID={`jj-${props.field}`}
    />
  );
}
function Parent({ id, model, pending }: { id: string; model: Model; pending: boolean }) {
  const remove = useCallback(() => model.removeParent(id), [model, id]);
  return (
    <Button variant="outline" size="sm" disabled={pending} onPress={remove}>
      {id.slice(0, 12)} ×
    </Button>
  );
}
function FileChoice({
  file,
  selected,
  model,
  pending,
}: {
  file: string;
  selected: boolean;
  model: Model;
  pending: boolean;
}) {
  const toggle = useCallback(() => model.toggleFile(file), [model, file]);
  return <SettingsSwitch label={file} value={selected} onValueChange={toggle} disabled={pending} />;
}
