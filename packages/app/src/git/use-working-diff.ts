import { useWorkspaceFields } from "@/stores/session-store-hooks";
import { useCallback, useEffect, useMemo } from "react";
import {
  buildWorkspaceAttachmentScopeKey,
  useWorkspaceAttachmentsStore,
} from "@/attachments/workspace-attachments-store";
import {
  buildReviewDraftKey,
  useInlineReviewController,
  useReviewAttachmentSnapshot,
  useReviewFeedback,
} from "@/review";
import { useCheckoutDiffQuery } from "@/git/use-diff-query";
import { useCheckoutStatusQuery } from "@/git/use-status-query";
import { useWorkingDiffComparison } from "@/git/working-diff-comparison";
import { useHostFeature } from "@/runtime/host-features";
import { buildDiffBaseSelectionKey, usePanelStore } from "@/stores/panel-store";

interface UseWorkingDiffOptions {
  serverId: string;
  workspaceId?: string;
  cwd: string;
  ignoreWhitespace: boolean;
  enabled: boolean;
  queryScope?: string;
  presentation?: string;
}

// COMPAT(workspaceDiffComparison): added in v0.11.0, remove after 2027-04-02 when the host floor supports shared comparisons.
function useDiffBaseSelection(input: {
  serverId: string;
  workspaceId?: string;
  cwd: string;
  defaultBaseRef: string | undefined;
}) {
  const supported = useHostFeature(input.serverId, "checkoutDiffBaseSelection");
  const selectionKey = useMemo(
    () =>
      buildDiffBaseSelectionKey({
        serverId: input.serverId,
        workspaceId: input.workspaceId,
        cwd: input.cwd,
      }),
    [input.cwd, input.serverId, input.workspaceId],
  );
  const persistedBaseRef = usePanelStore((state) =>
    selectionKey ? state.diffBaseRefByWorkspace[selectionKey] : undefined,
  );
  const setDiffBaseRefForWorkspace = usePanelStore((state) => state.setDiffBaseRefForWorkspace);
  const selectedBaseRef = supported ? (persistedBaseRef ?? null) : null;
  const selectBaseRef = useCallback(
    (nextBaseRef: string | null) => {
      if (selectionKey) {
        setDiffBaseRefForWorkspace(selectionKey, nextBaseRef);
      }
    },
    [selectionKey, setDiffBaseRefForWorkspace],
  );
  return {
    canSelectBase: supported && selectionKey !== null,
    effectiveBaseRef: selectedBaseRef ?? input.defaultBaseRef,
    selectedBaseRef,
    selectBaseRef,
  };
}

function useComparisonSelection({
  serverId,
  workspaceId,
  cwd,
  baseRef,
}: {
  serverId: string;
  workspaceId?: string;
  cwd: string;
  baseRef?: string;
}) {
  const {
    canSelectBase,
    effectiveBaseRef: legacyBaseRef,
    selectedBaseRef,
    selectBaseRef,
  } = useDiffBaseSelection({
    serverId,
    workspaceId,
    cwd,
    defaultBaseRef: baseRef,
  });

  const { comparison: legacyMode, selectComparison } = useWorkingDiffComparison({
    serverId,
    workspaceId,
    cwd,
  });
  const unifiedComparison =
    useHostFeature(serverId, "workspaceDiffComparisonV2") && Boolean(workspaceId);
  const hostComparison = useWorkspaceFields(
    serverId,
    workspaceId ?? null,
    (workspace) => workspace.diffComparisonV2,
  );
  const resolvedBaseRef = useWorkspaceFields(
    serverId,
    workspaceId ?? null,
    (workspace) => workspace.diffComparisonResolvedBase,
  );
  const comparisonError = useWorkspaceFields(
    serverId,
    workspaceId ?? null,
    (workspace) => workspace.diffComparisonError,
  );
  const diffMode = unifiedComparison ? (hostComparison?.mode ?? "all") : legacyMode;
  const effectiveBaseRef = unifiedComparison ? (resolvedBaseRef ?? undefined) : legacyBaseRef;
  const selectUncommitted = useCallback(() => selectComparison("uncommitted"), [selectComparison]);
  const selectBase = useCallback(() => selectComparison("base"), [selectComparison]);
  const selectAll = useCallback(() => selectComparison("all"), [selectComparison]);
  return {
    canSelectBase,
    effectiveBaseRef,
    selectedBaseRef,
    selectBaseRef,
    diffMode,
    unifiedComparison,
    hostComparison,
    comparisonError,
    selectUncommitted,
    selectBase,
    selectAll,
  };
}

// oxlint-disable-next-line complexity
export function useWorkingDiff({
  serverId,
  workspaceId,
  cwd,
  ignoreWhitespace,
  enabled,
  queryScope,
  presentation,
}: UseWorkingDiffOptions) {
  const {
    status,
    isLoading: isStatusLoading,
    isError: isStatusError,
    error: statusError,
  } = useCheckoutStatusQuery({ serverId, cwd });
  const gitStatus = status && status.isGit ? status : null;
  const isGit = Boolean(gitStatus);
  const notGit = status !== null && !status.isGit && !status.error;
  const statusErrorMessage =
    status?.error?.message ??
    (isStatusError && statusError instanceof Error ? statusError.message : null);
  const baseRef = gitStatus?.baseRef ?? undefined;
  const currentBranchName =
    gitStatus?.currentBranch && gitStatus.currentBranch !== "HEAD" ? gitStatus.currentBranch : null;
  const {
    canSelectBase,
    effectiveBaseRef,
    selectedBaseRef,
    selectBaseRef,
    diffMode,
    unifiedComparison,
    hostComparison,
    comparisonError,
    selectUncommitted,
    selectBase,
    selectAll,
  } = useComparisonSelection({
    serverId,
    workspaceId,
    cwd,
    baseRef,
  });
  const reviewBaseRef = unifiedComparison || diffMode === "base" ? effectiveBaseRef : baseRef;

  const {
    files,
    payloadError: diffPayloadError,
    diffTooLarge,
    isLoading: isDiffLoading,
  } = useCheckoutDiffQuery({
    serverId,
    cwd,
    mode: diffMode,
    baseRef: reviewBaseRef,
    ignoreWhitespace,
    enabled:
      enabled &&
      isGit &&
      (!unifiedComparison ||
        Boolean(hostComparison && (diffMode === "uncommitted" || effectiveBaseRef))),
    queryScope,
  });
  const reviewDraftKey = useMemo(
    () =>
      buildReviewDraftKey({
        serverId,
        workspaceId,
        cwd,
        mode: diffMode,
        baseRef: reviewBaseRef,
        ignoreWhitespace,
      }),
    [cwd, diffMode, ignoreWhitespace, reviewBaseRef, serverId, workspaceId],
  );
  const reviewActions = useInlineReviewController({ reviewDraftKey, presentation });
  const reviewAttachment = useReviewAttachmentSnapshot({
    key: reviewDraftKey,
    diffFiles: files,
    cwd,
    mode: diffMode,
    baseRef: reviewBaseRef,
  });

  const reviewFeedback = useReviewFeedback({
    serverId,
    workspaceId,
    reviewDraftKey,
    attachment: reviewAttachment,
  });

  return {
    status,
    isStatusLoading,
    isGit,
    notGit,
    statusErrorMessage,
    baseRef,
    effectiveBaseRef,
    canSelectBase,
    unifiedComparison,
    selectedBaseRef,
    selectBaseRef,
    currentBranchName,
    diffMode,
    selectUncommitted,
    selectBase,
    selectAll,
    files,
    diffPayloadError: comparisonError
      ? { code: "UNKNOWN" as const, message: comparisonError }
      : diffPayloadError,
    diffTooLarge,
    isDiffLoading: isDiffLoading && !comparisonError,
    reviewActions,
    reviewAttachment,
    reviewFeedback,
  };
}

export function usePublishWorkingDiffAttachment({
  serverId,
  workspaceId,
  cwd,
  attachment,
  enabled,
}: {
  serverId: string;
  workspaceId?: string;
  cwd: string;
  attachment: ReturnType<typeof useWorkingDiff>["reviewAttachment"];
  enabled: boolean;
}) {
  const scopeKey = useMemo(
    () => buildWorkspaceAttachmentScopeKey({ serverId, workspaceId, cwd }),
    [cwd, serverId, workspaceId],
  );
  const setWorkspaceAttachments = useWorkspaceAttachmentsStore(
    (state) => state.setWorkspaceAttachments,
  );
  const clearWorkspaceAttachments = useWorkspaceAttachmentsStore(
    (state) => state.clearWorkspaceAttachments,
  );

  useEffect(() => {
    if (!enabled) {
      return;
    }
    const attachments = attachment ? [attachment] : [];
    setWorkspaceAttachments({ scopeKey, attachments });
    return () => {
      const current = useWorkspaceAttachmentsStore.getState().attachmentsByScope[scopeKey];
      if (current === attachments) {
        clearWorkspaceAttachments({ scopeKey });
      }
    };
  }, [attachment, clearWorkspaceAttachments, enabled, scopeKey, setWorkspaceAttachments]);
}
