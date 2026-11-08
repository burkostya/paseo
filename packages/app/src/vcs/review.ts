import { useWorkspace } from "@/stores/session-store-hooks";
import { useChangesPreferences } from "@/hooks/use-changes-preferences";
import { legacyGitReviewKey } from "./git-comparison-compat";
import { useReviewDraftStore, adoptReviewDrafts } from "@/review/store";
import { vcsReviewDraftKey } from "./selection";
import { useMemo, useEffect } from "react";
import type { VcsSnapshot, VcsComparison } from "@getpaseo/protocol/vcs";
import type { ParsedDiffFile } from "@getpaseo/protocol/diff";
import {
  useInlineReviewController,
  useReviewAttachmentSnapshot,
  useReviewFeedback,
} from "@/review";
import { usePublishReviewAttachment } from "@/review/workspace-attachment";
import type { VcsPaneState } from "./state";

export function useVcsReview(input: {
  serverId: string;
  workspaceId: string;
  snapshot: VcsSnapshot;
  comparison: VcsComparison;
  state: VcsPaneState;
  files: ParsedDiffFile[];
  enabled: boolean;
  reviewScope?: string;
}) {
  const { serverId, workspaceId, snapshot, comparison, state, files, enabled } = input;
  const workspace = useWorkspace(serverId, workspaceId);
  const { preferences } = useChangesPreferences();
  const legacyKey = legacyGitReviewKey({
    serverId,
    workspace,
    state,
    ignoreWhitespace: preferences.hideWhitespace,
    reviewScope: input.reviewScope,
  });
  const reviewDraftKey =
    legacyKey ?? vcsReviewDraftKey(serverId, workspaceId, snapshot, state, input.reviewScope);
  const oldKey = vcsReviewDraftKey(serverId, workspaceId, snapshot, state);
  const oldDefaultKey = vcsReviewDraftKey(serverId, workspaceId, snapshot, {
    ...state,
    comparisonId: undefined,
  });
  const oldComments = useReviewDraftStore((store) => store.drafts[oldKey]);
  const oldDefaultComments = useReviewDraftStore((store) => store.drafts[oldDefaultKey]);
  useEffect(() => {
    // COMPAT(vcsGitReviewDrafts): v0.15.2; pre-base common UI used default/all for uncommitted drafts, remove after 2027-06-06.
    if (
      snapshot.binding.providerId !== "git" ||
      preferences.hideWhitespace ||
      state.range ||
      state.selection.kind !== "workspace"
    )
      return;
    const id = state.comparisonId ?? "default";
    let aliases: string[] = [];
    if (id === "all") aliases = [oldKey, oldDefaultKey];
    else if (["staged", "unstaged"].includes(id)) aliases = [oldKey];
    adoptReviewDrafts(reviewDraftKey, aliases);
  }, [
    snapshot.binding.providerId,
    preferences.hideWhitespace,
    state.range,
    state.selection.kind,
    state.comparisonId,
    reviewDraftKey,
    oldKey,
    oldDefaultKey,
    oldComments,
    oldDefaultComments,
  ]);
  const reviewActions = useInlineReviewController({ reviewDraftKey, files });
  const vcs = useMemo(
    () => ({
      providerId: snapshot.binding.providerId,
      repositoryId: snapshot.binding.repositoryId,
      workingCopyId: snapshot.binding.workingCopyId,
      version: snapshot.version,
      comparison,
    }),
    [snapshot, comparison],
  );
  const attachment = useReviewAttachmentSnapshot({
    key: reviewDraftKey,
    diffFiles: files,
    cwd: snapshot.binding.root,
    // COMPAT(vcsReviewAttachment): v0.15.2; keep the required legacy mode until old review readers expire, target 2027-06-06.
    mode: "uncommitted",
    vcs,
  });
  const feedback = useReviewFeedback({
    serverId,
    workspaceId,
    reviewDraftKey,
    attachment: enabled ? attachment : null,
  });
  usePublishReviewAttachment({
    serverId,
    workspaceId,
    cwd: snapshot.binding.cwd,
    attachment,
    enabled,
  });
  return { reviewActions, feedback };
}
