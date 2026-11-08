import type { VcsData } from "@getpaseo/protocol/vcs";
import type { WorkspaceDescriptor } from "@/stores/session-store";
import { buildReviewDraftKey } from "@/review/store";
import type { VcsPaneState } from "./state";

// COMPAT(vcsGitComparisonDefaults): v0.15.2; remove after project/workspace comparison settings use provider envelopes, target 2027-06-06.
export function gitComparisonDefaults(workspace: WorkspaceDescriptor | null): VcsData | undefined {
  if (workspace?.vcsProviderId !== "git") return undefined;
  return {
    version: 1,
    data: {
      mode: workspace.diffComparisonV2?.mode ?? "all",
      baseRef: workspace.diffComparisonResolvedBase ?? null,
      error: workspace.diffComparisonError ?? null,
      warning: workspace.diffComparisonWarning ?? null,
    },
  };
}

// COMPAT(vcsGitReviewDrafts): v0.15.2; reuse existing keys rather than copying/deleting user drafts, remove after 2027-06-06 with an explicit draft migration.
export function legacyGitReviewKey(input: {
  serverId: string;
  workspace: WorkspaceDescriptor | null;
  state: VcsPaneState;
  ignoreWhitespace: boolean;
  reviewScope?: string;
}): string | undefined {
  const { workspace, state } = input;
  if (workspace?.vcsProviderId !== "git" || state.selection.kind !== "workspace" || state.range)
    return;
  if (input.reviewScope) {
    // The provider's resolved scope owns the base; legacy descriptors may still be catching up.
    const scope = resolvedScope(input.reviewScope);
    if (!scope) return;
    return buildReviewDraftKey({
      serverId: input.serverId,
      workspaceId: workspace.id,
      cwd: workspace.workspaceDirectory,
      ...scope,
    });
  }

  const id = state.comparisonId ?? "default";
  let mode = workspace.diffComparisonV2?.mode ?? "all";
  if (id === "combined") mode = "all";
  else if (id === "committed") mode = "base";
  else if (id === "all") mode = "uncommitted";
  else if (id !== "default") return;
  return buildReviewDraftKey({
    serverId: input.serverId,
    workspaceId: workspace.id,
    cwd: workspace.workspaceDirectory,
    mode,
    baseRef:
      mode === "uncommitted" ? undefined : (state.baseRef ?? workspace.diffComparisonResolvedBase),
    ignoreWhitespace: input.ignoreWhitespace,
  });
}

function resolvedScope(value: string) {
  let scope: unknown;
  try {
    scope = JSON.parse(value);
  } catch {
    return;
  }
  if (!Array.isArray(scope) || scope.length !== 3) return;
  const [mode, baseRef, ignoreWhitespace] = scope;
  if (
    typeof mode !== "string" ||
    !["combined", "committed", "all"].includes(mode) ||
    (baseRef !== null && typeof baseRef !== "string") ||
    typeof ignoreWhitespace !== "boolean"
  )
    return;
  let legacyMode: "all" | "base" | "uncommitted" = "uncommitted";
  if (mode === "combined") legacyMode = "all";
  if (mode === "committed") legacyMode = "base";
  return {
    mode: legacyMode,
    baseRef: typeof baseRef === "string" ? baseRef : undefined,
    ignoreWhitespace,
  };
}
