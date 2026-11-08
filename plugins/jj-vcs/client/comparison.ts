import { jjSavedComparisonSettings } from "../shared/comparison.js";
import type { PluginVcsComparisonInput, PluginVcsComparisonResult } from "@getpaseo/plugin/client";
import type { PluginVcsRevisionComparisonInput } from "@getpaseo/plugin/client";

export function resolveJjRevisionComparison(
  input: PluginVcsRevisionComparisonInput,
): PluginVcsComparisonResult {
  if (!input.ignoreWhitespace) return { comparison: input.comparison };
  const comparison = input.comparison;
  const revision = comparison.kind === "revision" ? comparison.revision : comparison.to;
  return {
    comparison: {
      kind: "working-copy",
      data: {
        version: 1,
        data: {
          revision,
          ...(comparison.kind === "range" ? { base: comparison.from } : {}),
          operation: input.snapshot.version,
          ignoreWhitespace: true,
        },
      },
    },
    reviewScope: JSON.stringify(["revisions", comparison, true]),
  };
}

export function resolveJjComparison(input: PluginVcsComparisonInput): PluginVcsComparisonResult {
  const { selectBase, baseRef } = savedComparison(input);
  const matches = input.snapshot.refs.filter((ref) => ref.id === baseRef);
  const base =
    matches.length === 1 && matches[0]!.targets.length === 1 ? matches[0]!.targets[0] : undefined;
  let error: string | undefined;
  if (!input.snapshot.current) error = "Current change is unavailable. Refresh the workspace.";
  else if (selectBase && !base) error = "Select a bookmark with one unambiguous target.";
  else if (input.id && !["default", "change", "base"].includes(input.id))
    error = "Comparison is unavailable.";
  return {
    comparison: error
      ? null
      : {
          kind: "working-copy",
          data: {
            version: 1,
            data: {
              operation: input.snapshot.version,
              revision: input.snapshot.current!.id,
              ...(base ? { base } : {}),
              ignoreWhitespace: input.ignoreWhitespace,
            },
          },
        },
    error,
    reviewScope:
      selectBase || input.ignoreWhitespace
        ? JSON.stringify([selectBase ? "base" : "change", baseRef ?? null, input.ignoreWhitespace])
        : undefined,
    baseRef,
    selectBase,
  };
}

function savedComparison(input: PluginVcsComparisonInput) {
  const saved = input.defaults ? jjSavedComparisonSettings.parse(input.defaults).data : null;
  const mode = !input.id || input.id === "default" ? (saved?.mode ?? "change") : input.id;
  const selectBase = mode === "base";
  const inheritedBase = saved?.mode === "base" ? saved.baseRef : undefined;
  const baseRef = selectBase ? (input.baseRef ?? inheritedBase) : undefined;
  return { selectBase, baseRef };
}
