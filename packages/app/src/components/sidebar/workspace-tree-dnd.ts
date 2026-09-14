import type { SidebarWorkspacePlacement } from "@/hooks/sidebar-workspaces-view-model";
import type { WorkspaceTreeRow } from "./workspace-hierarchy";

export type WorkspaceTreeDropIntent =
  | { kind: "inside"; targetWorkspaceKey: string }
  | { kind: "before"; targetWorkspaceKey: string }
  | { kind: "after"; targetWorkspaceKey: string }
  | { kind: "root" };

/** Stable droppable id shared by the web and native tree drag adapters. */
export const WORKSPACE_TREE_ROOT_DROP_ZONE_ID = "__workspace-tree-root-drop-zone__";

export interface WorkspaceTreeDropResolution {
  accepted: boolean;
  reason?: "missing_source" | "missing_target" | "different_project" | "descendant_target";
  parentWorkspaceId: string | null;
  siblingIndex: number;
  workspaceOrder: string[];
}

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

function descendantsByKey(
  workspaces: readonly SidebarWorkspacePlacement[],
  parentKeyFor?: (workspace: SidebarWorkspacePlacement) => string | null,
): Map<string, Set<string>> {
  const children = new Map<string, string[]>();
  const byIdentity = new Map(
    workspaces.map((workspace) => [
      `${workspace.serverId}\u0000${workspace.workspaceId}`,
      workspace,
    ]),
  );
  for (const workspace of workspaces) {
    const parentKey = parentKeyFor
      ? parentKeyFor(workspace)
      : resolveParentKey(workspace, byIdentity);
    if (!parentKey) continue;
    const list = children.get(parentKey) ?? [];
    list.push(workspace.workspaceKey);
    children.set(parentKey, list);
  }
  const result = new Map<string, Set<string>>();
  for (const workspace of workspaces) {
    const descendants = new Set<string>();
    const stack = [...(children.get(workspace.workspaceKey) ?? [])];
    while (stack.length > 0) {
      const key = stack.pop();
      if (!key || descendants.has(key)) continue;
      descendants.add(key);
      stack.push(...(children.get(key) ?? []));
    }
    result.set(workspace.workspaceKey, descendants);
  }
  return result;
}

function flattenSiblingOrder(
  workspaces: readonly SidebarWorkspacePlacement[],
  order: readonly string[],
  parentKeyFor?: (workspace: SidebarWorkspacePlacement) => string | null,
): string[] {
  const children = new Map<string | null, SidebarWorkspacePlacement[]>();
  const byIdentity = new Map(
    workspaces.map((workspace) => [
      `${workspace.serverId}\u0000${workspace.workspaceId}`,
      workspace,
    ]),
  );
  for (const workspace of workspaces) {
    const parentKey = parentKeyFor
      ? parentKeyFor(workspace)
      : resolveParentKey(workspace, byIdentity);
    const siblings = children.get(parentKey) ?? [];
    siblings.push(workspace);
    children.set(parentKey, siblings);
  }
  const rank = new Map(order.map((key, index) => [key, index]));
  const sort = (items: readonly SidebarWorkspacePlacement[]) =>
    [...items].sort(
      (left, right) =>
        (rank.get(left.workspaceKey) ?? Number.MAX_SAFE_INTEGER) -
        (rank.get(right.workspaceKey) ?? Number.MAX_SAFE_INTEGER),
    );
  const output: string[] = [];
  const stack = sort(children.get(null) ?? [])
    .toReversed()
    .map((workspace) => ({ workspace }));
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    output.push(current.workspace.workspaceKey);
    for (const child of sort(children.get(current.workspace.workspaceKey) ?? []).toReversed()) {
      stack.push({ workspace: child });
    }
  }
  for (const workspace of workspaces) {
    if (!output.includes(workspace.workspaceKey)) output.push(workspace.workspaceKey);
  }
  return output;
}

type WorkspaceTreeDropRejection = NonNullable<WorkspaceTreeDropResolution["reason"]>;

function rejectedDrop(reason: WorkspaceTreeDropRejection): WorkspaceTreeDropResolution {
  return {
    accepted: false,
    reason,
    parentWorkspaceId: null,
    siblingIndex: -1,
    workspaceOrder: [],
  };
}

function validateWorkspaceTreeDrop(input: {
  workspaces: readonly SidebarWorkspacePlacement[];
  source: SidebarWorkspacePlacement | undefined;
  target: SidebarWorkspacePlacement | null;
  intent: WorkspaceTreeDropIntent;
  parentKeyFor?: (workspace: SidebarWorkspacePlacement) => string | null;
}): WorkspaceTreeDropRejection | null {
  const { source, target, intent, workspaces, parentKeyFor } = input;
  if (!source) return "missing_source";
  if (intent.kind !== "root" && !target) return "missing_target";
  if (target?.workspaceKey === source.workspaceKey) return "descendant_target";
  if (target && (target.serverId !== source.serverId || !sameWorkspaceProject(source, target))) {
    return "different_project";
  }
  const descendants = descendantsByKey(workspaces, parentKeyFor).get(source.workspaceKey);
  if (target && descendants?.has(target.workspaceKey)) return "descendant_target";
  return null;
}

function resolveWorkspaceTreePlacement(input: {
  workspaces: readonly SidebarWorkspacePlacement[];
  source: SidebarWorkspacePlacement;
  target: SidebarWorkspacePlacement | null;
  intent: WorkspaceTreeDropIntent;
  currentOrder: readonly string[];
  parentKeyFor?: (workspace: SidebarWorkspacePlacement) => string | null;
}): {
  parentWorkspaceId: string | null;
  siblingIndex: number;
  workspaceOrder: string[];
} {
  const { workspaces, source, target, intent, currentOrder } = input;
  const byKey = new Map(workspaces.map((workspace) => [workspace.workspaceKey, workspace]));
  const byIdentity = new Map(
    workspaces.map((workspace) => [
      `${workspace.serverId}\u0000${workspace.workspaceId}`,
      workspace,
    ]),
  );
  const resolveParent =
    input.parentKeyFor ??
    ((workspace: SidebarWorkspacePlacement) => resolveParentKey(workspace, byIdentity));
  const childrenByParent = buildChildrenByParent(workspaces, currentOrder, resolveParent);
  removeWorkspaceFromSiblingLists(childrenByParent, source.workspaceKey);

  const destinationParentKey = resolveDestinationParentKey({
    intent,
    target,
    parentKeyFor: resolveParent,
  });
  const destinationParentId = resolveDestinationParentId({
    intent,
    target,
    destinationParentKey,
    byKey,
  });
  const { siblings, siblingIndex } = insertSourceIntoSiblings({
    childrenByParent,
    destinationParentKey,
    source,
    target,
    intent,
  });
  childrenByParent.set(destinationParentKey, siblings);

  return {
    parentWorkspaceId: destinationParentId,
    siblingIndex,
    workspaceOrder: flattenWorkspaceTree(childrenByParent, workspaces),
  };
}

function resolveParentKey(
  workspace: SidebarWorkspacePlacement,
  byIdentity: ReadonlyMap<string, SidebarWorkspacePlacement>,
): string | null {
  const parentId = workspace.parentWorkspaceId ?? null;
  if (!parentId) return null;
  const parent = byIdentity.get(`${workspace.serverId}\u0000${parentId}`);
  if (!parent || !sameWorkspaceProject(workspace, parent)) {
    return null;
  }
  return parent.workspaceKey;
}

function buildChildrenByParent(
  workspaces: readonly SidebarWorkspacePlacement[],
  currentOrder: readonly string[],
  parentKeyFor: (workspace: SidebarWorkspacePlacement) => string | null,
): Map<string | null, SidebarWorkspacePlacement[]> {
  const rank = new Map(currentOrder.map((key, index) => [key, index]));
  const childrenByParent = new Map<string | null, SidebarWorkspacePlacement[]>();
  for (const workspace of workspaces) {
    const parentKey = parentKeyFor(workspace);
    const children = childrenByParent.get(parentKey) ?? [];
    children.push(workspace);
    childrenByParent.set(parentKey, children);
  }
  for (const [parentKey, children] of childrenByParent) {
    children.sort(
      (left, right) =>
        (rank.get(left.workspaceKey) ?? Number.MAX_SAFE_INTEGER) -
        (rank.get(right.workspaceKey) ?? Number.MAX_SAFE_INTEGER),
    );
    childrenByParent.set(parentKey, children);
  }
  return childrenByParent;
}

function removeWorkspaceFromSiblingLists(
  childrenByParent: Map<string | null, SidebarWorkspacePlacement[]>,
  workspaceKey: string,
): void {
  for (const [parentKey, children] of childrenByParent) {
    childrenByParent.set(
      parentKey,
      children.filter((workspace) => workspace.workspaceKey !== workspaceKey),
    );
  }
}

function resolveDestinationParentKey(input: {
  intent: WorkspaceTreeDropIntent;
  target: SidebarWorkspacePlacement | null;
  parentKeyFor: (workspace: SidebarWorkspacePlacement) => string | null;
}): string | null {
  if (input.intent.kind === "inside") return input.target?.workspaceKey ?? null;
  if (!input.target) return null;
  return input.parentKeyFor(input.target);
}

function resolveDestinationParentId(input: {
  intent: WorkspaceTreeDropIntent;
  target: SidebarWorkspacePlacement | null;
  destinationParentKey: string | null;
  byKey: ReadonlyMap<string, SidebarWorkspacePlacement>;
}): string | null {
  if (input.intent.kind === "inside") return input.target?.workspaceId ?? null;
  return input.byKey.get(input.destinationParentKey ?? "")?.workspaceId ?? null;
}

function insertSourceIntoSiblings(input: {
  childrenByParent: ReadonlyMap<string | null, SidebarWorkspacePlacement[]>;
  destinationParentKey: string | null;
  source: SidebarWorkspacePlacement;
  target: SidebarWorkspacePlacement | null;
  intent: WorkspaceTreeDropIntent;
}): { siblings: SidebarWorkspacePlacement[]; siblingIndex: number } {
  const siblings = [...(input.childrenByParent.get(input.destinationParentKey) ?? [])];
  const targetIndex = input.target
    ? siblings.findIndex((workspace) => workspace.workspaceKey === input.target?.workspaceKey)
    : -1;
  let siblingIndex = siblings.length;
  if (input.intent.kind === "before" && targetIndex >= 0) siblingIndex = targetIndex;
  if (input.intent.kind === "after" && targetIndex >= 0) siblingIndex = targetIndex + 1;
  siblings.splice(Math.max(0, Math.min(siblingIndex, siblings.length)), 0, input.source);
  return { siblings, siblingIndex };
}

function flattenWorkspaceTree(
  childrenByParent: ReadonlyMap<string | null, SidebarWorkspacePlacement[]>,
  workspaces: readonly SidebarWorkspacePlacement[],
): string[] {
  const workspaceOrder: string[] = [];
  const visited = new Set<string>();
  const stack = [...(childrenByParent.get(null) ?? [])].toReversed();
  while (stack.length > 0) {
    const workspace = stack.pop();
    if (!workspace || visited.has(workspace.workspaceKey)) continue;
    visited.add(workspace.workspaceKey);
    workspaceOrder.push(workspace.workspaceKey);
    for (const child of (childrenByParent.get(workspace.workspaceKey) ?? []).toReversed()) {
      stack.push(child);
    }
  }
  for (const workspace of workspaces) {
    if (!visited.has(workspace.workspaceKey)) workspaceOrder.push(workspace.workspaceKey);
  }
  return workspaceOrder;
}

/** Resolve a drop without mutating server state. The returned order is a local sibling priority. */
export function resolveWorkspaceTreeDrop(input: {
  rows: readonly WorkspaceTreeRow[];
  draggedWorkspaceKey: string;
  intent: WorkspaceTreeDropIntent;
  currentOrder?: readonly string[];
}): WorkspaceTreeDropResolution {
  const workspaces = input.rows.map((row) => row.workspace);
  const rowParentKeys = new Map(
    input.rows.map((row) => [row.workspace.workspaceKey, row.parentWorkspaceKey] as const),
  );
  const byIdentity = new Map(
    workspaces.map((workspace) => [
      `${workspace.serverId}\u0000${workspace.workspaceId}`,
      workspace,
    ]),
  );
  const parentKeyFor = (workspace: SidebarWorkspacePlacement): string | null =>
    rowParentKeys.has(workspace.workspaceKey)
      ? (rowParentKeys.get(workspace.workspaceKey) ?? null)
      : resolveParentKey(workspace, byIdentity);
  const source = workspaces.find(
    (workspace) => workspace.workspaceKey === input.draggedWorkspaceKey,
  );
  const targetKey = input.intent.kind === "root" ? null : input.intent.targetWorkspaceKey;
  const target = targetKey
    ? (workspaces.find((workspace) => workspace.workspaceKey === targetKey) ?? null)
    : null;
  const rejection = validateWorkspaceTreeDrop({
    workspaces,
    source,
    target,
    intent: input.intent,
    parentKeyFor,
  });
  if (rejection) return rejectedDrop(rejection);
  if (!source) return rejectedDrop("missing_source");

  const currentOrder = flattenSiblingOrder(
    workspaces,
    input.currentOrder ?? workspaces.map((item) => item.workspaceKey),
    parentKeyFor,
  );
  const { parentWorkspaceId, siblingIndex, workspaceOrder } = resolveWorkspaceTreePlacement({
    workspaces,
    source,
    target,
    intent: input.intent,
    currentOrder,
    parentKeyFor,
  });
  return { accepted: true, parentWorkspaceId, siblingIndex, workspaceOrder };
}

export function resolveWorkspaceTreeDropZone(input: {
  activeTop: number;
  activeHeight: number;
  targetTop: number;
  targetHeight: number;
  targetWorkspaceKey: string;
}): WorkspaceTreeDropIntent {
  const targetHeight = Math.max(input.targetHeight, 1);
  const activeCenter = input.activeTop + input.activeHeight / 2;
  const relative = (activeCenter - input.targetTop) / targetHeight;
  if (relative < 0.25) return { kind: "before", targetWorkspaceKey: input.targetWorkspaceKey };
  if (relative > 0.75) return { kind: "after", targetWorkspaceKey: input.targetWorkspaceKey };
  return { kind: "inside", targetWorkspaceKey: input.targetWorkspaceKey };
}

export interface WorkspaceTreeDropMeasurement {
  workspaceKey: string;
  offset: number;
  size: number;
}

/** Resolve the native drop target from measured cell positions and the draggable shared values. */
export function resolveWorkspaceTreeDropFromMeasurements(input: {
  activeOffset: number;
  activeSize: number;
  sourceWorkspaceKey: string;
  measurements: readonly WorkspaceTreeDropMeasurement[];
  rootDropZone?: WorkspaceTreeDropMeasurement | null;
}): WorkspaceTreeDropIntent | null {
  const activeCenter = input.activeOffset + input.activeSize / 2;
  const rootDropZone = input.rootDropZone;
  if (
    rootDropZone &&
    rootDropZone.size > 0 &&
    activeCenter >= rootDropZone.offset &&
    activeCenter <= rootDropZone.offset + rootDropZone.size
  ) {
    return { kind: "root" };
  }

  const candidates = input.measurements.filter(
    (measurement) => measurement.workspaceKey !== input.sourceWorkspaceKey && measurement.size > 0,
  );
  if (candidates.length === 0) return null;

  const containing = candidates.find(
    (measurement) =>
      activeCenter >= measurement.offset &&
      activeCenter <= measurement.offset + Math.max(measurement.size, 1),
  );
  if (containing) {
    return resolveWorkspaceTreeDropZone({
      activeTop: input.activeOffset,
      activeHeight: input.activeSize,
      targetTop: containing.offset,
      targetHeight: containing.size,
      targetWorkspaceKey: containing.workspaceKey,
    });
  }

  const nearest = [...candidates].sort((left, right) => {
    const leftDistance = Math.abs(activeCenter - (left.offset + left.size / 2));
    const rightDistance = Math.abs(activeCenter - (right.offset + right.size / 2));
    return leftDistance - rightDistance;
  })[0];
  if (!nearest) return null;
  return activeCenter < nearest.offset
    ? { kind: "before", targetWorkspaceKey: nearest.workspaceKey }
    : { kind: "after", targetWorkspaceKey: nearest.workspaceKey };
}
