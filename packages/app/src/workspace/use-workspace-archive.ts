import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { useToast } from "@/contexts/toast-context";
import type { ToastApi } from "@/components/toast-host";
import {
  confirmRiskyWorktreeArchive,
  DEFAULT_WORKTREE_ARCHIVE_WARNING_LABELS,
  type WorktreeArchiveWarningLabels,
} from "@/git/worktree-archive-warning";
import type { WorkspaceDescriptor } from "@/stores/session-store";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";
import { confirmDialog } from "@/utils/confirm-dialog";
import {
  archiveWorkspaceOptimistically,
  archiveWorkspaceSubtreeOptimistically,
  type WorkspaceArchiveHierarchyClient,
} from "@/workspace/workspace-archive";

function purgeArchivedWorkspaceState(input: { serverId: string; workspaceId: string }): void {
  const workspaceKey = buildWorkspaceTabPersistenceKey(input);
  if (workspaceKey) {
    useWorkspaceLayoutStore.getState().purgeWorkspace(workspaceKey);
  }
}

type ArchiveClient = Parameters<typeof archiveWorkspaceOptimistically>[0]["client"];

interface WorkspaceArchiveOperationFeedback {
  t: TFunction;
  toast: ToastApi;
  warningLabels: WorktreeArchiveWarningLabels;
  rootRisk: {
    isDirty?: boolean | null;
    aheadOfOrigin?: number | null;
    diffStat?: { additions: number; deletions: number } | null;
  };
  onArchiveStarted: () => void;
  onSetHiding?: (hiding: boolean) => void;
}

type WorkspaceHierarchyInspection = Awaited<
  ReturnType<WorkspaceArchiveHierarchyClient["inspectWorkspaceSubtree"]>
>;

async function inspectWorkspaceHierarchyForArchive(input: {
  client: WorkspaceArchiveHierarchyClient;
  workspaceId: string;
  feedback: Pick<WorkspaceArchiveOperationFeedback, "t" | "toast">;
}): Promise<WorkspaceHierarchyInspection | null> {
  try {
    const inspection = await input.client.inspectWorkspaceSubtree(input.workspaceId, "archive");
    if (inspection.error) {
      input.feedback.toast.error(inspection.error);
      return null;
    }
    return inspection;
  } catch (error) {
    input.feedback.toast.error(
      error instanceof Error
        ? error.message
        : input.feedback.t("sidebar.workspace.toasts.archiveFailed"),
    );
    return null;
  }
}

async function confirmWorkspaceHierarchyArchive(input: {
  inspection: WorkspaceHierarchyInspection;
  workspaceId: string;
  workspaceName: string;
  feedback: Pick<WorkspaceArchiveOperationFeedback, "t" | "warningLabels" | "rootRisk">;
}): Promise<boolean> {
  const descendantCount = Math.max(input.inspection.entries.length - 1, 0);
  if (descendantCount > 0) {
    const confirmed = await confirmDialog({
      title: input.feedback.t("sidebar.workspace.confirmations.archiveSubtreeTitle"),
      message: input.feedback.t("sidebar.workspace.confirmations.archiveSubtreeMessage", {
        workspaceName: input.workspaceName,
        descendantCount,
      }),
      confirmLabel: input.feedback.t("sidebar.workspace.confirmations.archiveSubtreeConfirm"),
      cancelLabel: input.feedback.t("sidebar.workspace.confirmations.cancel"),
      destructive: true,
    });
    if (!confirmed) return false;
  }

  const changingWorkspaceIds = new Set(input.inspection.changingWorkspaceIds);
  for (const entry of input.inspection.entries) {
    if (!changingWorkspaceIds.has(entry.workspaceId) || entry.workspaceKind !== "worktree") {
      continue;
    }
    const rootFallback =
      entry.workspaceId === input.workspaceId ? input.feedback.rootRisk : undefined;
    const confirmed = await confirmRiskyWorktreeArchive(
      {
        workspaceName:
          entry.workspaceName ??
          (entry.workspaceId === input.workspaceId ? input.workspaceName : entry.workspaceId),
        isDirty: entry.archiveHasUncommittedChanges ?? rootFallback?.isDirty,
        aheadOfOrigin: entry.archiveUnpushedCommitCount ?? rootFallback?.aheadOfOrigin,
        diffStat: entry.diffStat ?? rootFallback?.diffStat,
      },
      input.feedback.warningLabels,
    );
    if (!confirmed) return false;
  }
  return true;
}

async function executeWorkspaceHierarchyArchive(input: {
  client: WorkspaceArchiveHierarchyClient;
  serverId: string;
  workspaceId: string;
  expectedWorkspaceIds: readonly string[];
  feedback: Pick<
    WorkspaceArchiveOperationFeedback,
    "t" | "toast" | "onArchiveStarted" | "onSetHiding"
  >;
}): Promise<void> {
  input.feedback.onSetHiding?.(true);
  try {
    input.feedback.onArchiveStarted();
    const result = await archiveWorkspaceSubtreeOptimistically({
      client: input.client,
      workspace: { serverId: input.serverId, workspaceId: input.workspaceId },
      expectedWorkspaceIds: input.expectedWorkspaceIds,
    });
    if (!result.accepted) {
      input.feedback.toast.error(
        result.error ?? input.feedback.t("sidebar.workspace.toasts.archiveFailed"),
      );
      return;
    }
    for (const archivedWorkspaceId of input.expectedWorkspaceIds) {
      if (!result.failedWorkspaceIds.includes(archivedWorkspaceId)) {
        purgeArchivedWorkspaceState({ serverId: input.serverId, workspaceId: archivedWorkspaceId });
      }
    }
    if (result.failedWorkspaceIds.length > 0) {
      input.feedback.toast.error(
        input.feedback.t("sidebar.workspace.toasts.archivePartial", {
          failedCount: result.failedWorkspaceIds.length,
        }),
      );
    }
  } catch (error) {
    input.feedback.toast.error(
      error instanceof Error
        ? error.message
        : input.feedback.t("sidebar.workspace.toasts.archiveFailed"),
    );
  } finally {
    input.feedback.onSetHiding?.(false);
  }
}

async function archiveWorkspaceHierarchyRecord(input: {
  client: WorkspaceArchiveHierarchyClient;
  serverId: string;
  workspaceId: string;
  name: string;
  feedback: WorkspaceArchiveOperationFeedback;
}): Promise<void> {
  const { client, serverId, workspaceId, name, feedback } = input;
  const inspection = await inspectWorkspaceHierarchyForArchive({
    client,
    workspaceId,
    feedback,
  });
  if (!inspection) return;
  const confirmed = await confirmWorkspaceHierarchyArchive({
    inspection,
    workspaceId,
    workspaceName: name,
    feedback,
  });
  if (!confirmed) return;
  await executeWorkspaceHierarchyArchive({
    client,
    serverId,
    workspaceId,
    expectedWorkspaceIds: inspection.expectedWorkspaceIds,
    feedback,
  });
}

async function archiveWorkspaceLegacyRecord(input: {
  client: ArchiveClient;
  serverId: string;
  workspaceId: string;
  feedback: Pick<
    WorkspaceArchiveOperationFeedback,
    "toast" | "t" | "onArchiveStarted" | "onSetHiding"
  >;
}): Promise<void> {
  const { client, serverId, workspaceId, feedback } = input;
  const { t, toast, onArchiveStarted, onSetHiding } = feedback;
  onSetHiding?.(true);
  try {
    onArchiveStarted();
    await archiveWorkspaceOptimistically({
      client,
      workspace: {
        serverId,
        workspaceId,
      },
    });
    purgeArchivedWorkspaceState({ serverId, workspaceId });
  } catch (error) {
    toast.error(
      error instanceof Error ? error.message : t("sidebar.workspace.toasts.archiveFailed"),
    );
  } finally {
    onSetHiding?.(false);
  }
}

export interface ArchiveWorkspaceInput {
  serverId: string;
  workspaceId: string;
  workspaceKind: WorkspaceDescriptor["workspaceKind"];
  name: string;
  isDirty?: boolean | null;
  aheadOfOrigin?: number | null;
  diffStat?: { additions: number; deletions: number } | null;
  warningLabels?: WorktreeArchiveWarningLabels;
  onArchiveStarted: () => void;
  onSetHiding?: (hiding: boolean) => void;
}

export interface WorkspaceArchiveController {
  archive: () => void;
}

export function useWorkspaceArchive(input: ArchiveWorkspaceInput): WorkspaceArchiveController {
  const {
    serverId,
    workspaceId,
    workspaceKind,
    name,
    isDirty,
    aheadOfOrigin,
    diffStat,
    warningLabels = DEFAULT_WORKTREE_ARCHIVE_WARNING_LABELS,
    onArchiveStarted,
    onSetHiding,
  } = input;
  const { t } = useTranslation();
  const toast = useToast();

  const archiveWorkspaceRecord = useCallback(async () => {
    const client = getHostRuntimeStore().getClient(serverId);
    if (!client) {
      toast.error(t("sidebar.workspace.toasts.hostDisconnected"));
      return;
    }

    const supportsWorkspaceHierarchy =
      client.getLastServerInfoMessage()?.features?.workspaceHierarchy === true;
    if (supportsWorkspaceHierarchy) {
      await archiveWorkspaceHierarchyRecord({
        client: client as unknown as WorkspaceArchiveHierarchyClient,
        serverId,
        workspaceId,
        name,
        feedback: {
          t,
          toast,
          warningLabels,
          rootRisk: { isDirty, aheadOfOrigin, diffStat },
          onArchiveStarted,
          onSetHiding,
        },
      });
      return;
    }
    if (workspaceKind === "worktree") {
      const confirmed = await confirmRiskyWorktreeArchive(
        { workspaceName: name, isDirty, aheadOfOrigin, diffStat },
        warningLabels,
      );
      if (!confirmed) return;
    }
    await archiveWorkspaceLegacyRecord({
      client,
      serverId,
      workspaceId,
      feedback: { t, toast, onArchiveStarted, onSetHiding },
    });
  }, [
    aheadOfOrigin,
    diffStat,
    isDirty,
    name,
    onArchiveStarted,
    onSetHiding,
    serverId,
    t,
    toast,
    warningLabels,
    workspaceId,
    workspaceKind,
  ]);

  const archive = useCallback(() => {
    void (async () => {
      await archiveWorkspaceRecord();
    })();
  }, [archiveWorkspaceRecord]);

  return {
    archive,
  };
}
