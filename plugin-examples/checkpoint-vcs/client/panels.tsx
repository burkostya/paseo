import { useCallback, useMemo, useState } from "react";
import { Text } from "react-native";
import {
  useTranslation,
  type PluginVcsActionFormProps,
  type PluginVcsPanelProps,
} from "@getpaseo/plugin/client";
import { Button, Field, Form, FormTextInput } from "@getpaseo/plugin/client/ui";
import { messages } from "./messages.js";

export function CheckpointForm({ pending, submit, layout }: PluginVcsActionFormProps) {
  const { t } = useTranslation(messages);
  const [description, setDescription] = useState("");
  const save = useCallback(() => {
    void submit({ description: description.trim() });
  }, [submit, description]);
  const size = layout.compact ? "md" : "sm";
  return (
    <Form>
      <Field label={t("description")}>
        <FormTextInput
          initialValue=""
          onChangeText={setDescription}
          editable={!pending}
          size={size}
          testID="checkpoint-description"
        />
      </Field>
      <Button
        size={size}
        disabled={pending || !description.trim() || description.trim().length > 200}
        onPress={save}
        testID="checkpoint-save"
      >
        {t("create")}
      </Button>
    </Form>
  );
}

export function CheckpointDetails({ context, refresh, theme, layout }: PluginVcsPanelProps) {
  const { t } = useTranslation(messages);
  const style = useMemo(() => ({ color: theme.colors.foreground }), [theme.colors.foreground]);
  return (
    <Form>
      <Text style={style} testID="checkpoint-current">
        {context.snapshot.current?.description ?? t("empty")}
      </Text>
      <Text style={style}>
        {t("changed")}: {context.snapshot.files.length}
      </Text>
      <Button size={layout.compact ? "md" : "sm"} onPress={refresh}>
        {t("refresh")}
      </Button>
    </Form>
  );
}
