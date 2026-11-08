import { useCallback, useMemo } from "react";
import { View, Text } from "react-native";
import { useTranslation } from "react-i18next";
import type { PluginVcsComparisonResult } from "@getpaseo/plugin/client";
import type { VcsSnapshot } from "@getpaseo/protocol/vcs";
import { SelectField } from "@/components/ui/select-field";
import type { resolveVcsContribution } from "./contributions";
import type { VcsPaneState } from "./state";
import { vcsStyles } from "./styles";
import { selectWorkspaceComparison, selectComparisonBase } from "./selection";
export function VcsComparisonPicker(props: {
  snapshot: VcsSnapshot;
  result?: PluginVcsComparisonResult;
  resolved: ReturnType<typeof resolveVcsContribution>;
  state: VcsPaneState;
  setState(state: VcsPaneState): void;
}) {
  const { t } = useTranslation();
  const { state, setState, snapshot, resolved } = props;
  const options = useMemo(() => {
    const defaultTitle = resolved?.contribution.comparisonDefaultTitle;
    const defaultLabel =
      defaultTitle && resolved
        ? resolved.plugin.i18n.resolve(defaultTitle, resolved.plugin.locale)
        : t(
            resolved?.contribution.resolveComparison
              ? "vcs.inheritComparison"
              : "vcs.defaultComparison",
          );
    const entries = [
      {
        id: "default",
        value: "default",
        label: defaultLabel,
      },
    ];
    for (const item of resolved?.contribution.comparisons ?? []) {
      if (
        resolved?.contribution.resolveComparison ||
        snapshot.comparisons?.some((comparison) => comparison.id === item.id)
      )
        entries.push({
          id: item.id,
          value: item.id,
          label: resolved!.plugin.i18n.resolve(item.title, resolved!.plugin.locale),
        });
    }
    if (snapshot.current) entries.push({ id: "range", value: "range", label: t("vcs.range") });
    return entries;
  }, [resolved, snapshot, t]);
  const refs = useMemo(() => {
    const values = snapshot.refs
      .filter((ref) => ref.targets.length === 1)
      .map((ref) => ({ id: ref.id, value: ref.targets[0]!, label: ref.name }));
    if (snapshot.current)
      values.unshift({
        id: "current",
        value: snapshot.current.id,
        label: snapshot.current.id.slice(0, 12),
      });
    return values;
  }, [snapshot]);
  const value = state.range ? "range" : (state.comparisonId ?? "default");
  const display = useMemo(
    () => ({
      label: options.find((item) => item.value === value)?.label ?? options[0]!.label,
    }),
    [options, value],
  );
  const change = useCallback(
    (comparisonId: string) =>
      setState(selectWorkspaceComparison(state, comparisonId, snapshot.current)),
    [state, setState, snapshot],
  );
  const from = useCallback(
    (id: string) => {
      if (state.range) setState({ ...state, range: { ...state.range, from: id } });
    },
    [state, setState],
  );
  const to = useCallback(
    (id: string) => {
      if (state.range) setState({ ...state, range: { ...state.range, to: id } });
    },
    [state, setState],
  );
  const fromDisplay = useMemo(
    () => ({ label: state.range?.from.slice(0, 12) ?? "" }),
    [state.range?.from],
  );
  const toDisplay = useMemo(
    () => ({ label: state.range?.to.slice(0, 12) ?? "" }),
    [state.range?.to],
  );
  const baseDisplay = useMemo(
    () => ({
      label:
        snapshot.refs.find((ref) => ref.id === props.result?.baseRef)?.name ??
        props.result?.baseRef ??
        t("vcs.inheritBase"),
    }),
    [props.result?.baseRef, snapshot.refs, t],
  );
  const baseOptions = useMemo(
    () => [
      { id: "inherit", value: "", label: t("vcs.inheritBase") },
      ...snapshot.refs.map((ref) => ({ id: ref.id, value: ref.id, label: ref.name })),
    ],
    [snapshot.refs, t],
  );
  const changeBase = useCallback(
    (baseRef: string) => setState(selectComparisonBase(state, baseRef)),
    [state, setState],
  );
  if (
    state.view !== "changes" ||
    state.selection.kind !== "workspace" ||
    (!snapshot.comparisons?.length &&
      !resolved?.contribution.resolveComparison &&
      !resolved?.contribution.resolveRevisionComparison)
  )
    return null;
  return (
    <View style={vcsStyles.selection}>
      {props.result?.warning ? <Text style={vcsStyles.empty}>{props.result.warning}</Text> : null}
      <SelectField
        label={t("vcs.comparison")}
        value={value}
        selectedDisplay={display}
        options={options}
        onChange={change}
        placeholder=""
        emptyText=""
        size="sm"
        testID="vcs-comparison"
      />
      {props.result?.selectBase ? (
        <SelectField
          label={t("vcs.base")}
          value={state.baseRef ?? null}
          selectedDisplay={baseDisplay}
          options={baseOptions}
          onChange={changeBase}
          placeholder=""
          emptyText=""
          size="sm"
          testID="vcs-comparison-base"
        />
      ) : null}
      {state.range ? (
        <>
          <SelectField
            label={t("vcs.from")}
            value={state.range.from}
            selectedDisplay={fromDisplay}
            options={refs}
            onChange={from}
            placeholder=""
            emptyText=""
            size="sm"
            testID="vcs-comparison-from"
          />
          <SelectField
            label={t("vcs.to")}
            value={state.range.to}
            selectedDisplay={toDisplay}
            options={refs}
            onChange={to}
            placeholder=""
            emptyText=""
            size="sm"
            testID="vcs-comparison-to"
          />
        </>
      ) : null}
    </View>
  );
}
