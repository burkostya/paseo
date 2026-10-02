import pLimit from "p-limit";
import type { DiffComparison } from "@getpaseo/protocol/messages";
import { getComparisonShortstat } from "../../utils/checkout-git.js";
import type { WorkspaceGitRuntimeSnapshot } from "../workspace-git-service.js";
import type { PersistedProjectRecord, PersistedWorkspaceRecord } from "../workspace-registry.js";

interface ComparisonResult {
  diffStat: { additions: number; deletions: number } | null;
  diffComparisonError: string | null;
}
interface ComparisonEntry {
  result: ComparisonResult;
  pending: boolean;
  listeners: Map<object, (cwd: string) => void>;
}
const snapshots = new WeakMap<WorkspaceGitRuntimeSnapshot["git"], Map<string, ComparisonEntry>>();
const calculate = pLimit({ concurrency: 2 });
const EMPTY: ComparisonResult = { diffStat: null, diffComparisonError: null };
const DEFAULT: DiffComparison = { mode: "uncommitted" };

export function hasComparisonSnapshot(snapshot: WorkspaceGitRuntimeSnapshot | null): boolean {
  return snapshot !== null && snapshots.has(snapshot.git);
}

function getComparisonSnapshot(input: {
  snapshot: WorkspaceGitRuntimeSnapshot;
  comparison: DiffComparison;
  owner: object;
  onReady: (cwd: string) => void;
}): ComparisonResult {
  const { snapshot, comparison, owner, onReady } = input;
  let comparisons = snapshots.get(snapshot.git);
  if (!comparisons) {
    comparisons = new Map();
    snapshots.set(snapshot.git, comparisons);
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
  const diffCwd = snapshot.git.repoRoot ?? snapshot.cwd;
  void calculate(() => getComparisonShortstat(diffCwd, comparison)).then(
    (diffStat) => settle({ diffStat, diffComparisonError: null }),
    (error: unknown) =>
      settle({
        diffStat: null,
        diffComparisonError: error instanceof Error ? error.message : String(error),
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

export function describeWorkspaceComparison(input: {
  workspace: PersistedWorkspaceRecord;
  project: PersistedProjectRecord | null;
  snapshot: WorkspaceGitRuntimeSnapshot | null;
  owner: object;
  onReady: (cwd: string) => void;
}) {
  const projectDiffComparison = input.project?.diffComparison ?? DEFAULT;
  const diffComparisonOverride = input.workspace.diffComparison ?? null;
  const diffComparison = diffComparisonOverride ?? projectDiffComparison;
  const result = input.snapshot?.git.isGit
    ? getComparisonSnapshot({ ...input, snapshot: input.snapshot, comparison: diffComparison })
    : EMPTY;
  return { ...result, projectDiffComparison, diffComparisonOverride, diffComparison };
}
