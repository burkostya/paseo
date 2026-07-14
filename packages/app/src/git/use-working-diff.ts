import { useCallback, useEffect, useMemo } from "react";
import {
  buildWorkspaceAttachmentScopeKey,
  useWorkspaceAttachmentsStore,
} from "@/attachments/workspace-attachments-store";
import {
  buildReviewDraftKey,
  buildReviewDraftScopeKey,
  useInlineReviewController,
  useResolvedDiffMode,
  useReviewAttachmentSnapshot,
  useSetDiffModeOverride,
} from "@/review";
import { useCheckoutDiffQuery } from "@/git/use-diff-query";
import { useCheckoutStatusQuery } from "@/git/use-status-query";
import { useHostFeature } from "@/runtime/host-features";
import { buildDiffBaseSelectionKey, usePanelStore } from "@/stores/panel-store";

interface UseWorkingDiffOptions {
  serverId: string;
  workspaceId?: string;
  cwd: string;
  ignoreWhitespace: boolean;
  enabled: boolean;
  queryScope?: string;
}

export function useWorkingDiff({
  serverId,
  workspaceId,
  cwd,
  ignoreWhitespace,
  enabled,
  queryScope,
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
  const hasUncommittedChanges = Boolean(gitStatus?.isDirty);
  const currentBranchName =
    gitStatus?.currentBranch && gitStatus.currentBranch !== "HEAD" ? gitStatus.currentBranch : null;
  const supportsBaseSelection = useHostFeature(serverId, "checkoutDiffBaseSelection");
  const baseSelectionKey = useMemo(
    () => buildDiffBaseSelectionKey({ serverId, workspaceId, cwd }),
    [cwd, serverId, workspaceId],
  );
  const persistedBaseRef = usePanelStore((state) => {
    if (!baseSelectionKey) {
      return undefined;
    }
    return state.diffBaseRefByWorkspace[baseSelectionKey];
  });
  const setDiffBaseRefForWorkspace = usePanelStore((state) => state.setDiffBaseRefForWorkspace);
  const selectedBaseRef = supportsBaseSelection ? (persistedBaseRef ?? null) : null;
  const effectiveBaseRef = selectedBaseRef ?? baseRef;
  const selectBaseRef = useCallback(
    (nextBaseRef: string | null) => {
      if (!baseSelectionKey) {
        return;
      }
      setDiffBaseRefForWorkspace(baseSelectionKey, nextBaseRef);
    },
    [baseSelectionKey, setDiffBaseRefForWorkspace],
  );

  const reviewDraftScopeKey = useMemo(
    () =>
      buildReviewDraftScopeKey({
        serverId,
        workspaceId,
        cwd,
        baseRef,
        ignoreWhitespace,
      }),
    [baseRef, cwd, ignoreWhitespace, serverId, workspaceId],
  );
  const diffMode = useResolvedDiffMode({
    scopeKey: reviewDraftScopeKey,
    hasUncommittedChanges,
  });
  const setDiffModeOverride = useSetDiffModeOverride();
  const selectDiffMode = useCallback(
    (mode: "uncommitted" | "base") => {
      setDiffModeOverride({
        scopeKey: reviewDraftScopeKey,
        override: { serverId, cwd, mode, isDirtyAtSelection: hasUncommittedChanges },
      });
    },
    [cwd, hasUncommittedChanges, reviewDraftScopeKey, serverId, setDiffModeOverride],
  );
  const selectUncommitted = useCallback(() => selectDiffMode("uncommitted"), [selectDiffMode]);
  const selectBase = useCallback(() => selectDiffMode("base"), [selectDiffMode]);
  const reviewBaseRef = diffMode === "base" ? effectiveBaseRef : baseRef;

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
    enabled: enabled && isGit,
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
  const reviewActions = useInlineReviewController({ reviewDraftKey });
  const reviewAttachment = useReviewAttachmentSnapshot({
    key: reviewDraftKey,
    diffFiles: files,
    cwd,
    mode: diffMode,
    baseRef: reviewBaseRef,
  });

  return {
    status,
    isStatusLoading,
    isGit,
    notGit,
    statusErrorMessage,
    baseRef,
    effectiveBaseRef,
    canSelectBase: supportsBaseSelection && baseSelectionKey !== null,
    selectedBaseRef,
    selectBaseRef,
    currentBranchName,
    diffMode,
    selectUncommitted,
    selectBase,
    files,
    diffPayloadError,
    diffTooLarge,
    isDiffLoading,
    reviewActions,
    reviewAttachment,
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
