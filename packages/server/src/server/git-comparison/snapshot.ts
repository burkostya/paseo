import pLimit from "p-limit";
import type { DiffComparison, DiffComparisonV2 } from "@getpaseo/protocol/messages";
import { getComparisonShortstatV2, type CheckoutContext } from "../../utils/checkout-git.js";
import { comparisonBaseResolver } from "./base.js";
import type { WorkspaceGitRuntimeSnapshot } from "../workspace-git-service.js";
import type { PersistedProjectRecord, PersistedWorkspaceRecord } from "../workspace-registry.js";

interface ComparisonResult {
  diffStat: { additions: number; deletions: number } | null;
  diffComparisonError: string | null;
  diffComparisonResolvedBase: string | null;
  diffComparisonBaseSource: "explicit" | "pull_request" | "worktree" | "remote_head" | null;
  diffComparisonWarning: string | null;
}
interface ComparisonEntry {
  result: ComparisonResult;
  pending: boolean;
  listeners: Map<object, (cwd: string) => void>;
}
const snapshots = new WeakMap<WorkspaceGitRuntimeSnapshot, Map<string, ComparisonEntry>>();
const calculate = pLimit({ concurrency: 2 });
const EMPTY: ComparisonResult = {
  diffStat: null,
  diffComparisonError: null,
  diffComparisonResolvedBase: null,
  diffComparisonBaseSource: null,
  diffComparisonWarning: null,
};
const DEFAULT: DiffComparisonV2 = { mode: "all" };

export function hasComparisonSnapshot(snapshot: WorkspaceGitRuntimeSnapshot | null): boolean {
  return snapshot !== null && snapshots.has(snapshot);
}

function getComparisonSnapshot(input: {
  snapshot: WorkspaceGitRuntimeSnapshot;
  comparison: DiffComparisonV2;
  context?: CheckoutContext;
  owner: object;
  onReady: (cwd: string) => void;
}): ComparisonResult {
  const { snapshot, comparison, owner, onReady } = input;
  let comparisons = snapshots.get(snapshot);
  if (!comparisons) {
    comparisons = new Map();
    snapshots.set(snapshot, comparisons);
  }
  const key = JSON.stringify(comparison);
  const cached = comparisons.get(key);
  if (cached) {
    if (cached.pending) cached.listeners.set(owner, onReady);
    return cached.result;
  }
  const entry: ComparisonEntry = {
    result: EMPTY,
    pending: true,
    listeners: new Map([[owner, onReady]]),
  };
  comparisons.set(key, entry);
  const cwd = snapshot.cwd;
  void calculate(async () => {
    if (comparison.mode === "uncommitted") {
      return { ...EMPTY, diffStat: await getComparisonShortstatV2(cwd, comparison) };
    }
    const base = await comparisonBaseResolver.resolve({
      cwd,
      explicitBaseRef: comparison.baseRef,
      snapshot,
      context: input.context,
    });
    const diffStat = await getComparisonShortstatV2(cwd, { ...comparison, baseRef: base.baseRef });
    return {
      diffStat,
      diffComparisonError: null,
      diffComparisonResolvedBase: base.baseRef,
      diffComparisonBaseSource: base.source,
      diffComparisonWarning: base.warning ?? null,
    };
  }).then(settle, (error: unknown) =>
    settle({
      ...EMPTY,
      diffComparisonError: error instanceof Error ? error.message : String(error),
      diffComparisonWarning:
        comparison.mode !== "uncommitted" && !comparison.baseRef
          ? (snapshot.forge.error?.message ?? null)
          : null,
    }),
  );
  function settle(result: ComparisonResult) {
    entry.result = result;
    entry.pending = false;
    for (const listener of entry.listeners.values()) listener(snapshot.cwd);
    entry.listeners.clear();
  }
  return entry.result;
}

function fromLegacy(comparison: DiffComparison | undefined): DiffComparisonV2 | undefined {
  if (!comparison) return undefined;
  return comparison.mode === "base" ? { ...comparison, mode: "all" } : comparison;
}

function toLegacy(
  comparison: DiffComparisonV2,
  resolvedBase: string | null,
): DiffComparison | undefined {
  if (comparison.mode === "uncommitted") return comparison;
  const baseRef = comparison.baseRef ?? resolvedBase;
  return baseRef ? { mode: "base", baseRef } : undefined;
}

export function projectLegacyComparison(
  project: PersistedProjectRecord,
): DiffComparison | undefined {
  if (project.diffComparisonV2) return toLegacy(project.diffComparisonV2, null);
  return project.diffComparison;
}

export function describeWorkspaceComparison(input: {
  workspace: PersistedWorkspaceRecord;
  project: PersistedProjectRecord | null;
  snapshot: WorkspaceGitRuntimeSnapshot | null;
  context?: CheckoutContext;
  owner: object;
  onReady: (cwd: string) => void;
}) {
  const projectDiffComparisonV2 =
    input.project?.diffComparisonV2 ?? fromLegacy(input.project?.diffComparison) ?? DEFAULT;
  const diffComparisonOverrideV2 =
    input.workspace.diffComparisonV2 ?? fromLegacy(input.workspace.diffComparison) ?? null;
  const diffComparisonV2 = diffComparisonOverrideV2 ?? projectDiffComparisonV2;
  const result = input.snapshot?.git.isGit
    ? getComparisonSnapshot({ ...input, snapshot: input.snapshot, comparison: diffComparisonV2 })
    : EMPTY;
  const projectResolvedBase = diffComparisonOverrideV2 ? null : result.diffComparisonResolvedBase;
  return {
    ...result,
    projectDiffComparisonV2,
    diffComparisonOverrideV2,
    diffComparisonV2,
    projectDiffComparison: toLegacy(projectDiffComparisonV2, projectResolvedBase),
    diffComparisonOverride: diffComparisonOverrideV2
      ? (toLegacy(diffComparisonOverrideV2, result.diffComparisonResolvedBase) ?? null)
      : null,
    diffComparison: toLegacy(diffComparisonV2, result.diffComparisonResolvedBase),
  };
}
