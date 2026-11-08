import { useCallback } from "react";
import { useTranslation, type PluginVcsWorkingCopyFormProps } from "@getpaseo/plugin/client";
import { Field, FormTextInput } from "@getpaseo/plugin/client/ui";
import { messages } from "./messages.js";

export function WorkingCopyForm({
  value,
  onChange,
  disabled,
  layout,
}: PluginVcsWorkingCopyFormProps) {
  const { t } = useTranslation(messages);
  const data = value?.data;
  const name =
    data && typeof data === "object" && !Array.isArray(data) && typeof data.name === "string"
      ? data.name
      : "";
  const change = useCallback(
    (next: string) => {
      onChange(next.trim() ? { version: 1, data: { name: next.trim() } } : undefined);
    },
    [onChange],
  );
  return (
    <Field label={t("workingCopyName")}>
      <FormTextInput
        initialValue={name}
        onChangeText={change}
        editable={!disabled}
        size={layout.compact ? "md" : "sm"}
        testID="jj-working-copy-name"
      />
    </Field>
  );
}
