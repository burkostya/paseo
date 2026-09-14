import type {
  SidebarWorkspaceEntry,
  SidebarWorkspacePlacement,
} from "@/hooks/sidebar-workspaces-view-model";
import { SIDEBAR_GROUP_ITEM_LIMIT } from "./sidebar-group-limit";

export interface WorkspaceTreeRow {
  workspace: SidebarWorkspacePlacement;
  depth: number;
  parentWorkspaceKey: string | null;
  hasChildren: boolean;
  expanded: boolean;
}

export interface WorkspaceHierarchyInput {
  workspaces: readonly SidebarWorkspacePlacement[];
  workspaceEntriesByKey?: ReadonlyMap<string, SidebarWorkspaceEntry>;
  storedOrder?: readonly string[];
  collapsedKeys?: ReadonlySet<string>;
}

function identityKey(serverId: string, workspaceId: string): string {
  return `${serverId}\u0000${workspaceId}`;
}

/**
 * A project view can merge several daemon placements, so the view key alone cannot establish a
 * parent relationship. Fixtures created before project identity was threaded through the sidebar
 * omit `projectId`; those legacy values are safe to compare only when both sides omit it.
 */
function sameWorkspaceProject(
  left: Pick<SidebarWorkspacePlacement, "serverId" | "projectId" | "projectViewKey">,
  right: Pick<SidebarWorkspacePlacement, "serverId" | "projectId" | "projectViewKey">,
): boolean {
  if (left.serverId !== right.serverId) return false;
  if (left.projectId !== undefined && right.projectId !== undefined) {
    return left.projectId === right.projectId;
  }
  return (
    left.projectId === undefined &&
    right.projectId === undefined &&
    left.projectViewKey === right.projectViewKey
  );
}

function orderSiblings(
  siblings: readonly SidebarWorkspacePlacement[],
  storedOrder: readonly string[],
): SidebarWorkspacePlacement[] {
  if (siblings.length < 2 || storedOrder.length === 0) return [...siblings];
  const rank = new Map(storedOrder.map((key, index) => [key, index]));
  return [...siblings].sort((left, right) => {
    const leftRank = rank.get(left.workspaceKey);
    const rightRank = rank.get(right.workspaceKey);
    if (leftRank !== undefined && rightRank !== undefined) return leftRank - rightRank;
    if (leftRank !== undefined) return -1;
    if (rightRank !== undefined) return 1;
    return 0;
  });
}

/**
 * Converts direct parent links into the visible preorder used by the project sidebar.
 * Invalid links are treated as roots so a damaged record cannot make the list disappear.
 */
// oxlint-disable-next-line complexity
export function buildWorkspaceTreeRows(input: WorkspaceHierarchyInput): WorkspaceTreeRow[] {
  const workspaces = [...input.workspaces];
  const byIdentity = new Map(
    workspaces.map((workspace) => [
      identityKey(workspace.serverId, workspace.workspaceId),
      workspace,
    ]),
  );
  const entriesByIdentity = new Map(
    Array.from(input.workspaceEntriesByKey?.values() ?? []).map((workspace) => [
      identityKey(workspace.serverId, workspace.workspaceId),
      workspace,
    ]),
  );
  const parentByKey = new Map<string, string | null>();
  const childrenByParent = new Map<string | null, SidebarWorkspacePlacement[]>();

  for (const workspace of workspaces) {
    const parentKey = resolveVisibleParentKey({
      workspace,
      visibleByIdentity: byIdentity,
      entriesByIdentity,
    });
    parentByKey.set(workspace.workspaceKey, parentKey);
  }

  // Break malformed cycles deterministically. A node whose parent chain loops is promoted to a
  // root; all valid descendants remain attached to it.
  for (const workspace of workspaces) {
    const seen = new Set<string>();
    let current: string | null = workspace.workspaceKey;
    let cycle = false;
    while (current) {
      if (seen.has(current)) {
        cycle = true;
        break;
      }
      seen.add(current);
      current = parentByKey.get(current) ?? null;
    }
    if (cycle) parentByKey.set(workspace.workspaceKey, null);
  }

  for (const workspace of workspaces) {
    const parentKey = parentByKey.get(workspace.workspaceKey) ?? null;
    const siblings = childrenByParent.get(parentKey);
    if (siblings) siblings.push(workspace);
    else childrenByParent.set(parentKey, [workspace]);
  }

  const rows: WorkspaceTreeRow[] = [];
  const collapsedKeys = input.collapsedKeys ?? new Set<string>();
  const storedOrder = input.storedOrder ?? [];
  const stack: Array<{
    workspace: SidebarWorkspacePlacement;
    depth: number;
    parentWorkspaceKey: string | null;
  }> = orderSiblings(childrenByParent.get(null) ?? [], storedOrder)
    .toReversed()
    .map((workspace) => ({ workspace, depth: 0, parentWorkspaceKey: null }));
  const visited = new Set<string>();

  while (stack.length > 0) {
    const current = stack.pop()!;
    if (visited.has(current.workspace.workspaceKey)) continue;
    visited.add(current.workspace.workspaceKey);
    const children = orderSiblings(
      childrenByParent.get(current.workspace.workspaceKey) ?? [],
      storedOrder,
    );
    const expanded = !collapsedKeys.has(current.workspace.workspaceKey);
    rows.push({
      workspace: current.workspace,
      depth: current.depth,
      parentWorkspaceKey: current.parentWorkspaceKey,
      hasChildren: children.length > 0,
      expanded,
    });
    if (!expanded) {
      const hidden = [...children];
      while (hidden.length > 0) {
        const child = hidden.pop();
        if (!child || visited.has(child.workspaceKey)) continue;
        visited.add(child.workspaceKey);
        hidden.push(...(childrenByParent.get(child.workspaceKey) ?? []));
      }
      continue;
    }
    for (const child of children.toReversed()) {
      stack.push({
        workspace: child,
        depth: current.depth + 1,
        parentWorkspaceKey: current.workspace.workspaceKey,
      });
    }
  }

  // Include orphaned/cyclic records that were not reachable from the roots.
  for (const workspace of workspaces) {
    if (visited.has(workspace.workspaceKey)) continue;
    rows.push({
      workspace,
      depth: 0,
      parentWorkspaceKey: null,
      hasChildren: (childrenByParent.get(workspace.workspaceKey) ?? []).length > 0,
      expanded: !collapsedKeys.has(workspace.workspaceKey),
    });
  }
  return rows;
}

/**
 * Resolve a visible parent, skipping records hidden by a sidebar projection (for example a pinned
 * workspace). The returned key always belongs to `input.workspaces`; the persisted parent link is
 * left untouched.
 */
function resolveVisibleParentKey(input: {
  workspace: SidebarWorkspacePlacement;
  visibleByIdentity: ReadonlyMap<string, SidebarWorkspacePlacement>;
  entriesByIdentity: ReadonlyMap<string, SidebarWorkspaceEntry>;
}): string | null {
  const { workspace, visibleByIdentity, entriesByIdentity } = input;
  const entry = entriesByIdentity.get(identityKey(workspace.serverId, workspace.workspaceId));
  let parentId = workspace.parentWorkspaceId ?? entry?.parentWorkspaceId ?? null;
  const visited = new Set<string>();

  while (parentId) {
    if (visited.has(parentId)) return null;
    visited.add(parentId);

    const parent = visibleByIdentity.get(identityKey(workspace.serverId, parentId));
    if (parent) {
      return parent.workspaceKey !== workspace.workspaceKey &&
        sameWorkspaceProject(workspace, parent)
        ? parent.workspaceKey
        : null;
    }

    const hiddenParent = entriesByIdentity.get(identityKey(workspace.serverId, parentId));
    if (!hiddenParent || !sameWorkspaceProject(workspace, hiddenParent)) return null;
    parentId = hiddenParent.parentWorkspaceId ?? null;
  }
  return null;
}

export function collectWorkspaceDescendantKeys(
  workspaces: readonly SidebarWorkspacePlacement[],
  workspaceKey: string,
): Set<string> {
  const descendants = new Set<string>();
  const childrenByParent = new Map<string, string[]>();
  const byIdentity = new Map(
    workspaces.map((workspace) => [
      identityKey(workspace.serverId, workspace.workspaceId),
      workspace,
    ]),
  );
  for (const workspace of workspaces) {
    const parentId = workspace.parentWorkspaceId ?? null;
    if (!parentId) continue;
    const parent = byIdentity.get(identityKey(workspace.serverId, parentId));
    if (!parent || !sameWorkspaceProject(workspace, parent)) {
      continue;
    }
    const children = childrenByParent.get(parent.workspaceKey) ?? [];
    children.push(workspace.workspaceKey);
    childrenByParent.set(parent.workspaceKey, children);
  }
  const stack = [...(childrenByParent.get(workspaceKey) ?? [])];
  while (stack.length > 0) {
    const key = stack.pop()!;
    if (descendants.has(key)) continue;
    descendants.add(key);
    stack.push(...(childrenByParent.get(key) ?? []));
  }
  return descendants;
}

/** Apply the sidebar's item limit to complete root branches, never to a child in the middle. */
export function limitWorkspaceTreeRows(
  rows: readonly WorkspaceTreeRow[],
  limit = SIDEBAR_GROUP_ITEM_LIMIT,
): WorkspaceTreeRow[] {
  const roots = rows.filter((row) => row.parentWorkspaceKey === null);
  if (roots.length <= limit) return [...rows];
  const visibleRootKeys = new Set(
    roots.slice(0, Math.max(0, limit)).map((row) => row.workspace.workspaceKey),
  );
  const rootKeyByRow = new Map<string, string>();
  const rowByKey = new Map(rows.map((row) => [row.workspace.workspaceKey, row]));
  const resolveRootKey = (row: WorkspaceTreeRow): string => {
    const cached = rootKeyByRow.get(row.workspace.workspaceKey);
    if (cached) return cached;
    const seen = new Set<string>();
    let current = row;
    while (current.parentWorkspaceKey) {
      if (seen.has(current.workspace.workspaceKey)) break;
      seen.add(current.workspace.workspaceKey);
      const parent = rowByKey.get(current.parentWorkspaceKey);
      if (!parent) break;
      current = parent;
    }
    const rootKey = current.workspace.workspaceKey;
    rootKeyByRow.set(row.workspace.workspaceKey, rootKey);
    return rootKey;
  };
  return rows.filter((row) => visibleRootKeys.has(resolveRootKey(row)));
}
