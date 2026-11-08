import type { PluginVcsComparisonInput, PluginVcsComparisonResult } from "@getpaseo/plugin/client";
import {
  gitComparisonDefaults,
  gitSavedComparisonSettings,
  gitSnapshotComparisonBase,
  resolveGitBaseName,
} from "../shared/comparison.js";
import type { PluginVcsRevisionComparisonInput } from "@getpaseo/plugin/client";

export function resolveGitRevisionComparison(
  input: PluginVcsRevisionComparisonInput,
): PluginVcsComparisonResult {
  if (!input.ignoreWhitespace) return { comparison: input.comparison };
  return {
    comparison: {
      kind: "working-copy",
      data: { version: 3, data: { comparison: input.comparison, ignoreWhitespace: true } },
    },
    reviewScope: JSON.stringify(["revisions", input.comparison, true]),
  };
}
export function resolveGitComparison(input: PluginVcsComparisonInput): PluginVcsComparisonResult {
  const defaults = comparisonDefaults(input);
  const mode = comparisonMode(input.id, defaults?.mode);
  const selectBase = mode === "combined" || mode === "committed";
  const baseRef = selectBase ? (input.baseRef ?? defaults?.baseRef ?? undefined) : undefined;
  const base = resolveBase(input.snapshot.refs, baseRef);
  const reviewScope = JSON.stringify([mode, baseRef ?? null, input.ignoreWhitespace]);
  let error: string | undefined;
  if (selectBase && !baseRef) error = defaults?.error ?? "Select a comparison base";
  else if (selectBase && !base) error = `Comparison base is unavailable or ambiguous: ${baseRef}`;
  return {
    comparison: error
      ? null
      : {
          kind: "working-copy",
          data: {
            version: 2,
            data: {
              version: input.snapshot.version,
              mode,
              ignoreWhitespace: input.ignoreWhitespace,
              ...(base ? { base } : {}),
            },
          },
        },
    error,
    warning: defaults?.warning ?? undefined,
    reviewScope,
    baseRef,
    selectBase,
  };
}

function comparisonMode(id: string | undefined, inherited: string | undefined): string {
  if (id && id !== "default") return id;
  if (inherited === "all") return "combined";
  if (inherited === "base") return "committed";
  return "all";
}
function resolveBase(
  refs: PluginVcsComparisonInput["snapshot"]["refs"],
  name?: string,
): string | undefined {
  const exact = refs.filter((ref) => ref.id === name);
  const candidates = exact.length ? exact : refs.filter((ref) => ref.name === name);
  if (candidates.length === 0)
    return name && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(name) ? name : undefined;
  if (candidates.length !== 1 || candidates[0]!.targets.length !== 1) return;
  return candidates[0]!.targets[0];
}

function comparisonDefaults(input: PluginVcsComparisonInput) {
  const saved = gitSavedComparisonSettings.safeParse(
    input.defaults ?? { version: 1, data: { mode: "all" } },
  );
  const snapshot = gitSnapshotComparisonBase.safeParse(input.snapshot.data);
  if (saved.success && snapshot.success) {
    const explicit = saved.data.data.baseRef;
    const automatic = snapshot.data.data.comparisonBase;
    return {
      mode: saved.data.data.mode,
      baseRef: explicit
        ? (resolveGitBaseName(input.snapshot.refs, explicit) ?? explicit)
        : automatic.baseRef,
      error: explicit ? null : automatic.error,
      warning: explicit ? null : automatic.warning,
    };
  }
  // COMPAT(vcsLegacyComparisonDefaults): v0.15.2; older hosts supply resolved defaults until 2027-06-06.
  const legacy = gitComparisonDefaults.safeParse(input.defaults);
  return legacy.success ? legacy.data.data : null;
}
