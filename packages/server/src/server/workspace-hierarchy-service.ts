import {
  resolveWorkspaceDisplayName,
  type PersistedWorkspaceRecord,
  type WorkspaceRegistry,
} from "./workspace-registry.js";

export type WorkspaceHierarchyAction = "archive" | "restore";

export interface WorkspaceHierarchyEntry {
  workspaceId: string;
  projectId: string;
  workspaceName: string;
  /** Persisted kind lets clients reuse the existing worktree archive warning. */
  workspaceKind: PersistedWorkspaceRecord["kind"];
  parentWorkspaceId: string | null;
  archivedAt: string | null;
  archived: boolean;
  archiveHasUncommittedChanges?: boolean | null;
  archiveUnpushedCommitCount?: number | null;
  diffStat?: { additions: number; deletions: number } | null;
}

export interface WorkspaceHierarchyInspection {
  workspaceId: string;
  action: WorkspaceHierarchyAction;
  entries: WorkspaceHierarchyEntry[];
  expectedWorkspaceIds: string[];
  changingWorkspaceIds: string[];
}

export interface WorkspaceHierarchyOperationResult {
  workspaceId: string;
  status: "succeeded" | "unchanged" | "failed";
  error: string | null;
}

/**
 * Shared daemon-side guard for lifecycle operations that touch a workspace tree.
 * Sessions are created per socket, so the websocket server owns one instance and
 * injects it into every session. A workspace is considered busy for the whole
 * operation, including records that are already archived.
 */
export class WorkspaceHierarchyBusyError extends Error {
  constructor(workspaceIds: readonly string[]) {
    super(`Workspace hierarchy operation already in progress: ${workspaceIds.join(", ")}`);
    this.name = "WorkspaceHierarchyBusyError";
  }
}

export class WorkspaceHierarchyOperationCoordinator {
  private readonly busyWorkspaceIds = new Set<string>();

  async run<T>(workspaceIds: readonly string[], operation: () => Promise<T>): Promise<T> {
    const ids = [...new Set(workspaceIds)].filter((id) => id.length > 0);
    const conflicts = ids.filter((id) => this.busyWorkspaceIds.has(id));
    if (conflicts.length > 0) {
      throw new WorkspaceHierarchyBusyError(conflicts);
    }
    for (const id of ids) this.busyWorkspaceIds.add(id);
    try {
      return await operation();
    } finally {
      for (const id of ids) this.busyWorkspaceIds.delete(id);
    }
  }

  isBusy(workspaceId: string): boolean {
    return this.busyWorkspaceIds.has(workspaceId);
  }
}

function toEntry(record: PersistedWorkspaceRecord): WorkspaceHierarchyEntry {
  return {
    workspaceId: record.workspaceId,
    projectId: record.projectId,
    workspaceName: resolveWorkspaceDisplayName(record),
    workspaceKind: record.kind,
    parentWorkspaceId: record.parentWorkspaceId ?? null,
    archivedAt: record.archivedAt,
    archived: Boolean(record.archivedAt),
  };
}

/**
 * Return the selected record and all descendants in the same project. The walk
 * is iterative and tolerates missing links or corrupt cycles in old cache files.
 */
export function collectWorkspaceSubtree(
  records: readonly PersistedWorkspaceRecord[],
  workspaceId: string,
): PersistedWorkspaceRecord[] {
  const root = records.find((record) => record.workspaceId === workspaceId);
  if (!root) return [];

  const byParent = new Map<string, PersistedWorkspaceRecord[]>();
  for (const record of records) {
    const parentId = record.parentWorkspaceId ?? null;
    if (!parentId || record.projectId !== root.projectId) continue;
    const children = byParent.get(parentId) ?? [];
    children.push(record);
    byParent.set(parentId, children);
  }

  const result: PersistedWorkspaceRecord[] = [];
  const visited = new Set<string>();
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || visited.has(current.workspaceId)) continue;
    visited.add(current.workspaceId);
    result.push(current);
    const children = byParent.get(current.workspaceId) ?? [];
    // The stack is LIFO; push in reverse so persisted sibling order remains stable in the
    // returned preorder and in the archive/restore result list.
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const child = children[index];
      if (child) stack.push(child);
    }
  }
  return result;
}

function depthOf(
  record: PersistedWorkspaceRecord,
  byId: ReadonlyMap<string, PersistedWorkspaceRecord>,
) {
  let depth = 0;
  let current = record;
  const visited = new Set<string>();
  while (current.parentWorkspaceId) {
    if (visited.has(current.workspaceId)) break;
    visited.add(current.workspaceId);
    const parent = byId.get(current.parentWorkspaceId);
    if (!parent || parent.projectId !== record.projectId) break;
    depth += 1;
    current = parent;
  }
  return depth;
}

export function inspectWorkspaceSubtree(input: {
  records: readonly PersistedWorkspaceRecord[];
  workspaceId: string;
  action: WorkspaceHierarchyAction;
}): WorkspaceHierarchyInspection {
  const records = collectWorkspaceSubtree(input.records, input.workspaceId);
  if (records.length === 0) throw new Error(`Workspace not found: ${input.workspaceId}`);
  const entries = records.map(toEntry);
  const expectedWorkspaceIds = records.map((record) => record.workspaceId);
  const changingWorkspaceIds = records
    .filter((record) =>
      input.action === "archive" ? !record.archivedAt : Boolean(record.archivedAt),
    )
    .map((record) => record.workspaceId);
  return {
    workspaceId: input.workspaceId,
    action: input.action,
    entries,
    expectedWorkspaceIds,
    changingWorkspaceIds,
  };
}

export function orderWorkspaceSubtree(
  records: readonly PersistedWorkspaceRecord[],
  rootWorkspaceId: string,
  direction: "parent-first" | "child-first",
): PersistedWorkspaceRecord[] {
  const subtree = collectWorkspaceSubtree(records, rootWorkspaceId);
  const byId = new Map(subtree.map((record) => [record.workspaceId, record]));
  return [...subtree].sort((left, right) => {
    const depthDifference = depthOf(left, byId) - depthOf(right, byId);
    return direction === "parent-first" ? depthDifference : -depthDifference;
  });
}

export async function inspectWorkspaceSubtreeFromRegistry(input: {
  workspaceRegistry: Pick<WorkspaceRegistry, "list">;
  workspaceId: string;
  action: WorkspaceHierarchyAction;
}): Promise<WorkspaceHierarchyInspection> {
  return inspectWorkspaceSubtree({
    records: await input.workspaceRegistry.list(),
    workspaceId: input.workspaceId,
    action: input.action,
  });
}
