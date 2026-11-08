import { useMemo, useCallback } from "react";
import type { PluginVcsComparisonSettingsProps } from "@getpaseo/plugin/client";
import { useTranslation } from "@getpaseo/plugin/client";
import { Field, FormTextInput, SelectField } from "@getpaseo/plugin/client/ui";
import { gitSavedComparisonSettings } from "../shared/comparison.js";
import { messages } from "./messages.js";

export function ComparisonSettings({
  value,
  onChange,
  disabled,
  layout,
}: PluginVcsComparisonSettingsProps) {
  const { t } = useTranslation(messages);
  const data = useMemo(
    () => (value ? gitSavedComparisonSettings.parse(value).data : { mode: "all" as const }),
    [value],
  );
  const options = useMemo(
    () => [
      { id: "all", value: "all", label: t("comparisons.combined") },
      { id: "base", value: "base", label: t("comparisons.committed") },
      { id: "uncommitted", value: "uncommitted", label: t("comparisons.all") },
    ],
    [t],
  );
  const changeMode = useCallback(
    (mode: string) => onChange({ version: 1, data: { ...data, mode } }),
    [data, onChange],
  );
  const changeBase = useCallback(
    (baseRef: string) =>
      onChange({
        version: 1,
        data: { mode: data.mode, ...(baseRef.trim() ? { baseRef: baseRef.trim() } : {}) },
      }),
    [data.mode, onChange],
  );
  const size = layout.compact ? "md" : "sm";
  return (
    <>
      <SelectField
        placeholder={t("choose")}
        emptyText={t("empty")}
        label={t("comparisonMode")}
        value={data.mode}
        selectedDisplay={options.find((option) => option.value === data.mode)!}
        options={options}
        onChange={changeMode}
        disabled={disabled}
        size={size}
        testID="git-comparison-settings-mode"
      />
      {data.mode !== "uncommitted" && (
        <Field label={t("comparisonBaseRef")}>
          <FormTextInput
            initialValue={data.baseRef ?? ""}
            onChangeText={changeBase}
            editable={!disabled}
            size={size}
            testID="git-comparison-settings-base"
          />
        </Field>
      )}
    </>
  );
}
