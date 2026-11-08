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
  const branch =
    data && typeof data === "object" && !Array.isArray(data) && typeof data.branch === "string"
      ? data.branch
      : "";
  const change = useCallback(
    (next: string) => {
      onChange(next.trim() ? { version: 1, data: { branch: next.trim() } } : undefined);
    },
    [onChange],
  );
  return (
    <Field label={t("workingCopyBranch")}>
      <FormTextInput
        initialValue={branch}
        onChangeText={change}
        editable={!disabled}
        size={layout.compact ? "md" : "sm"}
        testID="git-working-copy-branch"
      />
    </Field>
  );
}
