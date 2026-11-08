import { useMemo, useCallback } from "react";
import type { PluginVcsComparisonSettingsProps } from "@getpaseo/plugin/client";
import { useTranslation } from "@getpaseo/plugin/client";
import { SelectField } from "@getpaseo/plugin/client/ui";
import { messages } from "./messages.js";

export function ComparisonSettings({
  value,
  onChange,
  snapshot,
  disabled,
  layout,
}: PluginVcsComparisonSettingsProps) {
  const { t } = useTranslation(messages);
  // The base picker may hold an incomplete draft; the server validates on save.
  const data =
    value?.version === 1 &&
    value.data &&
    typeof value.data === "object" &&
    !Array.isArray(value.data)
      ? value.data
      : {};
  const mode = data.mode === "base" ? "base" : "change";
  const baseRef = typeof data.baseRef === "string" ? data.baseRef : "";
  const options = useMemo(
    () => [
      { id: "change", value: "change", label: t("comparisonChange") },
      { id: "base", value: "base", label: t("comparisonBase") },
    ],
    [t],
  );
  const refs = useMemo(
    () => snapshot.refs.map((ref) => ({ id: ref.id, value: ref.id, label: ref.name })),
    [snapshot.refs],
  );
  const display = useMemo(
    () => (baseRef ? { label: refs.find((ref) => ref.value === baseRef)?.label ?? baseRef } : null),
    [baseRef, refs],
  );
  const changeMode = useCallback(
    (next: string) =>
      onChange({
        version: 1,
        data: next === "base" ? { mode: next, baseRef } : { mode: "change" },
      }),
    [baseRef, onChange],
  );
  const changeBase = useCallback(
    (next: string) => onChange({ version: 1, data: { mode: "base", baseRef: next } }),
    [onChange],
  );
  const size = layout.compact ? "md" : "sm";
  return (
    <>
      <SelectField
        placeholder={t("choose")}
        emptyText={t("empty")}
        label={t("comparisonMode")}
        value={mode}
        selectedDisplay={options.find((option) => option.value === mode)!}
        options={options}
        onChange={changeMode}
        disabled={disabled}
        size={size}
        testID="jj-comparison-settings-mode"
      />
      {mode === "base" && (
        <SelectField
          placeholder={t("choose")}
          emptyText={t("empty")}
          label={t("comparisonBase")}
          value={baseRef || null}
          selectedDisplay={display}
          options={refs}
          onChange={changeBase}
          disabled={disabled}
          size={size}
          searchable
          testID="jj-comparison-settings-base"
        />
      )}
    </>
  );
}
