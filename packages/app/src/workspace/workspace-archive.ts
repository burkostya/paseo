import { getHostRuntimeStore } from "@/runtime/host-runtime";
import {
  clearWorkspaceArchivePending,
  markWorkspaceArchivePending,
} from "@/contexts/session-workspace-upserts";
import { useSessionStore, type WorkspaceDescriptor } from "@/stores/session-store";
import { resolveWorkspaceMapKeyByIdentity } from "@/utils/workspace-identity";
import { i18n } from "@/i18n/i18next";

export interface WorkspaceArchiveTarget {
  serverId: string;
  workspaceId: string;
}

interface WorkspaceArchiveClient {
  archiveWorkspace: (workspaceId: string) => Promise<{ error: string | null }>;
}

export interface WorkspaceArchiveHierarchyClient extends WorkspaceArchiveClient {
  archiveWorkspaceSubtree: (
    workspaceId: string,
    expectedWorkspaceIds: readonly string[],
  ) => Promise<{
    accepted: boolean;
    error: string | null;
    results: Array<{
      workspaceId: string;
      status: "succeeded" | "unchanged" | "failed";
      error: string | null;
    }>;
  }>;
  inspectWorkspaceSubtree: (
    workspaceId: string,
    action: "archive" | "restore",
  ) => Promise<{
    workspaceId: string;
    error: string | null;
    entries: Array<{
      workspaceId: string;
      workspaceName?: string;
      workspaceKind?: "local_checkout" | "worktree" | "directory";
      archiveHasUncommittedChanges?: boolean | null;
      archiveUnpushedCommitCount?: number | null;
      diffStat?: { additions: number; deletions: number } | null;
    }>;
    expectedWorkspaceIds: string[];
    changingWorkspaceIds: string[];
  }>;
}

interface OptimisticWorkspaceArchiveSnapshot {
  workspace: WorkspaceDescriptor | null;
}

export interface WorkspaceArchiveFailure {
  serverId: string;
  workspaceId: string;
  error: unknown;
}

function isWorkspaceArchiveFailure(error: unknown): error is WorkspaceArchiveFailure {
  return (
    typeof error === "object" &&
    error !== null &&
    "serverId" in error &&
    typeof error.serverId === "string" &&
    "workspaceId" in error &&
    typeof error.workspaceId === "string" &&
    "error" in error
  );
}

function hideWorkspaceOptimistically(
  workspace: WorkspaceArchiveTarget,
): OptimisticWorkspaceArchiveSnapshot {
  const workspaces = useSessionStore.getState().sessions[workspace.serverId]?.workspaces;
  const workspaceKey = resolveWorkspaceMapKeyByIdentity({
    workspaces,
    workspaceId: workspace.workspaceId,
  });
  const snapshot = workspaceKey ? (workspaces?.get(workspaceKey) ?? null) : null;
  markWorkspaceArchivePending({
    serverId: workspace.serverId,
    workspaceId: workspace.workspaceId,
  });
  getHostRuntimeStore().removeWorkspaceSnapshot(workspace.serverId, workspace.workspaceId);
  return { workspace: snapshot };
}

function restoreOptimisticallyHiddenWorkspace(input: {
  serverId: string;
  workspaceId: string;
  snapshot: OptimisticWorkspaceArchiveSnapshot;
}): void {
  clearWorkspaceArchivePending({
    serverId: input.serverId,
    workspaceId: input.workspaceId,
  });
  if (input.snapshot.workspace) {
    getHostRuntimeStore().acceptWorkspaceSnapshots(input.serverId, [input.snapshot.workspace]);
  }
}

function hideWorkspacesOptimistically(
  workspaces: readonly WorkspaceArchiveTarget[],
): Map<string, OptimisticWorkspaceArchiveSnapshot> {
  const snapshots = new Map<string, OptimisticWorkspaceArchiveSnapshot>();
  for (const workspace of workspaces) {
    snapshots.set(workspace.workspaceId, hideWorkspaceOptimistically(workspace));
  }
  return snapshots;
}

function restoreOptimisticallyHiddenWorkspaces(input: {
  serverId: string;
  snapshots: ReadonlyMap<string, OptimisticWorkspaceArchiveSnapshot>;
  workspaceIds?: ReadonlySet<string>;
}): void {
  for (const [workspaceId, snapshot] of input.snapshots) {
    if (input.workspaceIds && !input.workspaceIds.has(workspaceId)) continue;
    restoreOptimisticallyHiddenWorkspace({
      serverId: input.serverId,
      workspaceId,
      snapshot,
    });
  }
}

async function archiveWorkspaceOrThrow(input: {
  client: WorkspaceArchiveClient;
  workspaceId: string;
}): Promise<void> {
  const payload = await input.client.archiveWorkspace(input.workspaceId);
  if (payload.error) {
    throw new Error(payload.error);
  }
}

export async function archiveWorkspaceOptimistically(input: {
  client: WorkspaceArchiveClient;
  workspace: WorkspaceArchiveTarget;
}): Promise<void> {
  const snapshot = hideWorkspaceOptimistically(input.workspace);

  try {
    await archiveWorkspaceOrThrow({
      client: input.client,
      workspaceId: input.workspace.workspaceId,
    });
  } catch (error) {
    restoreOptimisticallyHiddenWorkspace({
      serverId: input.workspace.serverId,
      workspaceId: input.workspace.workspaceId,
      snapshot,
    });
    throw error;
  }
}

/**
 * Hide every workspace in a daemon-inspected subtree while the archive request is in flight.
 * Successful records stay hidden; records reported as failed are restored from their snapshots so
 * a partial operation leaves the UI actionable for a retry.
 */
export async function archiveWorkspaceSubtreeOptimistically(input: {
  client: WorkspaceArchiveHierarchyClient;
  workspace: WorkspaceArchiveTarget;
  expectedWorkspaceIds: readonly string[];
}): Promise<{
  accepted: boolean;
  error: string | null;
  failedWorkspaceIds: string[];
}> {
  const expectedWorkspaceIds = Array.from(
    new Set([input.workspace.workspaceId, ...input.expectedWorkspaceIds]),
  );
  const snapshots = hideWorkspacesOptimistically(
    expectedWorkspaceIds.map((workspaceId) => ({
      serverId: input.workspace.serverId,
      workspaceId,
    })),
  );

  try {
    const payload = await input.client.archiveWorkspaceSubtree(
      input.workspace.workspaceId,
      expectedWorkspaceIds,
    );
    if (!payload.accepted) {
      restoreOptimisticallyHiddenWorkspaces({
        serverId: input.workspace.serverId,
        snapshots,
      });
      return {
        accepted: false,
        error: payload.error,
        failedWorkspaceIds: expectedWorkspaceIds,
      };
    }

    const resultByWorkspaceId = new Map(
      payload.results.map((result) => [result.workspaceId, result]),
    );
    const failedWorkspaceIds = expectedWorkspaceIds.filter(
      (workspaceId) =>
        resultByWorkspaceId.get(workspaceId)?.status === "failed" ||
        !resultByWorkspaceId.has(workspaceId),
    );
    for (const workspaceId of expectedWorkspaceIds) {
      clearWorkspaceArchivePending({
        serverId: input.workspace.serverId,
        workspaceId,
      });
    }
    restoreOptimisticallyHiddenWorkspaces({
      serverId: input.workspace.serverId,
      snapshots,
      workspaceIds: new Set(failedWorkspaceIds),
    });
    return {
      accepted: true,
      error: payload.error,
      failedWorkspaceIds,
    };
  } catch (error) {
    restoreOptimisticallyHiddenWorkspaces({
      serverId: input.workspace.serverId,
      snapshots,
    });
    throw error;
  }
}

export async function archiveWorkspacesOptimistically(input: {
  getClient: (serverId: string) => WorkspaceArchiveClient | null;
  workspaces: WorkspaceArchiveTarget[];
}): Promise<WorkspaceArchiveFailure[]> {
  const results = await Promise.allSettled(
    input.workspaces.map(async (workspace) => {
      const client = input.getClient(workspace.serverId);
      if (!client) {
        throw {
          serverId: workspace.serverId,
          workspaceId: workspace.workspaceId,
          error: new Error(i18n.t("sidebar.workspace.toasts.hostDisconnected")),
        } satisfies WorkspaceArchiveFailure;
      }

      try {
        await archiveWorkspaceOptimistically({
          client,
          workspace,
        });
      } catch (error) {
        throw {
          serverId: workspace.serverId,
          workspaceId: workspace.workspaceId,
          error,
        } satisfies WorkspaceArchiveFailure;
      }
    }),
  );

  return results.flatMap((result) =>
    result.status === "rejected" && isWorkspaceArchiveFailure(result.reason) ? [result.reason] : [],
  );
}
