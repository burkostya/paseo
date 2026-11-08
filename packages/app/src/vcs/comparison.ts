import type {
  PluginText,
  PluginVcsContribution,
  PluginVcsSelection,
  PluginVcsComparisonResult,
} from "@getpaseo/plugin/client";
import type { VcsSnapshot, VcsData, VcsComparison } from "@getpaseo/protocol/vcs";
import type { VcsPaneState } from "./state";
import { selectionComparison } from "./selection";

interface ComparisonInput {
  snapshot: VcsSnapshot;
  state: VcsPaneState;
  selection: PluginVcsSelection;
  form: boolean;
  ignoreWhitespace: boolean;
  defaults?: VcsData;
  contribution?: PluginVcsContribution<PluginText>;
}

export function resolvePaneComparison(input: ComparisonInput): PluginVcsComparisonResult {
  const { snapshot, state, selection, contribution } = input;
  if (input.form) return { comparison: selectionComparison(selection, snapshot) };
  if (selection.kind === "workspace" && !state.range) {
    return (
      contribution?.resolveComparison?.({
        snapshot,
        defaults: input.defaults,
        id: state.comparisonId,
        baseRef: state.baseRef,
        ignoreWhitespace: input.ignoreWhitespace,
      }) ?? {
        comparison:
          snapshot.comparisons?.find((item) => item.id === state.comparisonId)?.comparison ??
          selectionComparison(selection, snapshot),
      }
    );
  }
  const comparison: VcsComparison | null =
    selection.kind === "workspace" && state.range
      ? { kind: "range", ...state.range }
      : selectionComparison(selection, snapshot);
  if (!comparison || comparison.kind === "working-copy") return { comparison };
  return (
    contribution?.resolveRevisionComparison?.({
      snapshot,
      comparison,
      ignoreWhitespace: input.ignoreWhitespace,
    }) ?? { comparison }
  );
}
