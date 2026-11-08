import type { VcsPaneState, VcsComparisonRequest } from "./state";
import type { ParsedDiffFile } from "@getpaseo/protocol/diff";
import type { PluginVcsSelection } from "@getpaseo/plugin/client";
import type { VcsComparison, VcsSnapshot } from "@getpaseo/protocol/vcs";
export function selectWorkspaceComparison(
  state: VcsPaneState,
  comparisonId: string,
  current: VcsSnapshot["current"],
): VcsPaneState {
  const { range: _range, ...rest } = state;
  const next = { ...rest, comparisonId };
  return comparisonId === "range" && current
    ? { ...next, range: { from: current.parents[0] ?? current.id, to: current.id } }
    : next;
}

export function selectComparisonBase(state: VcsPaneState, baseRef: string): VcsPaneState {
  const { baseRef: _baseRef, ...rest } = state;
  return baseRef ? { ...rest, baseRef } : rest;
}

export function selectionRevision(selection: PluginVcsSelection, snapshot: VcsSnapshot) {
  if (selection.kind === "workspace") return snapshot.current;
  if (selection.kind === "revision") return selection.revision;
  return selection.revision;
}
export function selectionComparison(
  selection: PluginVcsSelection,
  snapshot: VcsSnapshot,
): VcsComparison | null {
  if (selection.kind === "workspace") return snapshot.workingComparison ?? { kind: "working-copy" };
  const id =
    selection.kind === "revision"
      ? selection.revision.id
      : (selection.revision?.id ??
        (selection.ref.targets.length === 1 ? selection.ref.targets[0] : null));
  return id ? { kind: "revision", revision: id } : null;
}

/** COMPAT(vcsGitUi): v0.15.2; remove after 2027-06-06 when pre-comparison hosts expire. */
export function usesProviderVcsUi(
  providerId: string | undefined,
  comparisonViews = false,
): boolean {
  return !!providerId && (providerId !== "git" || comparisonViews);
}

export function workspaceHasVcsChanges(
  isGit: boolean,
  workspace: { vcsProviderId?: string } | null,
): boolean {
  return isGit || usesProviderVcsUi(workspace?.vcsProviderId);
}

export type VcsFilePaths = Pick<ParsedDiffFile, "path" | "oldPath"> &
  Pick<VcsSnapshot["files"][number], "previousPath">;

export function selectedDiffFiles(
  files: readonly VcsFilePaths[],
  path: string,
  kind: "file" | "directory",
) {
  return [
    ...new Set(
      files
        .filter((file) => (kind === "file" ? file.path === path : file.path.startsWith(`${path}/`)))
        .flatMap((file) => {
          const previous = file.previousPath ?? file.oldPath;
          return previous ? [file.path, previous] : [file.path];
        }),
    ),
  ];
}

export function vcsReviewDraftKey(
  serverId: string,
  workspaceId: string,
  snapshot: VcsSnapshot,
  state: VcsPaneState,
  reviewScope?: string,
) {
  const selection = state.selection;
  // Working-copy drafts survive refresh; explicit revisions never share their line coordinates.
  const scope =
    selection.kind === "workspace"
      ? ["workspace", state.comparisonId ?? "default", state.range ?? null]
      : [selection.kind, selection.revision?.id ?? null];
  return JSON.stringify([
    "vcs-review",
    serverId,
    workspaceId,
    snapshot.binding.providerId,
    snapshot.binding.repositoryId,
    snapshot.binding.workingCopyId,
    reviewScope ?? scope,
  ]);
}

export function applyComparisonRequest(
  state: VcsPaneState,
  request: VcsComparisonRequest | undefined,
  providerId: string | undefined,
): VcsPaneState {
  if (
    !request ||
    request.providerId !== providerId ||
    request.requestId === state.consumedComparisonRequestId
  )
    return state;
  const { comparisonId: _comparisonId, baseRef: _baseRef, range: _range, ...rest } = state;
  return {
    ...rest,
    view: "changes",
    providerId: request.providerId,
    selection: request.selection,
    ...(request.comparisonId !== undefined ? { comparisonId: request.comparisonId } : {}),
    ...(request.baseRef !== undefined ? { baseRef: request.baseRef } : {}),
    ...(request.range !== undefined ? { range: request.range } : {}),
    consumedComparisonRequestId: request.requestId,
  };
}
