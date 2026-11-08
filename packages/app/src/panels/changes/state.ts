import { vcsPaneStateSchema } from "@/vcs/state";
import { z } from "zod";

export const changesStateSchema = z
  .strictObject({
    // COMPAT(changesPaneState): fields persisted by v0.5.0-beta.3; remove after 2026-11-21. Preferences are global and mode selection is ephemeral.
    mode: z.enum(["uncommitted", "base"]).optional(),
    baseRef: z.string().optional(),
    layout: z.enum(["unified", "split"]).optional(),
    wrapLines: z.boolean().optional(),
    hideWhitespace: z.boolean().optional(),
    vcs: vcsPaneStateSchema.optional(),
    // COMPAT(vcsGitReview): v0.15.2; accept and discard the removed mode until 2027-06-06.
    gitLegacyReview: z.boolean().optional(),
    treeVisible: z.boolean(),
    treeWidth: z.number().optional(),
    collapsedFilePaths: z.array(z.string()),
    collapsedFolderPaths: z.array(z.string()),
    commitsCollapsed: z.boolean(),
  })
  .transform(
    ({
      gitLegacyReview: _gitLegacyReview,
      mode: _mode,
      baseRef: _baseRef,
      layout: _layout,
      wrapLines: _wrapLines,
      hideWhitespace: _hideWhitespace,
      ...paneState
    }) => {
      if (!_gitLegacyReview || !paneState.vcs) return paneState;
      const {
        comparisonId: _comparisonId,
        baseRef: _vcsBaseRef,
        range: _range,
        ...vcs
      } = paneState.vcs;
      return {
        ...paneState,
        vcs: { ...vcs, view: "changes", selection: { kind: "workspace" as const } },
      };
    },
  );

export type ChangesState = z.infer<typeof changesStateSchema>;

export const defaultChangesState: ChangesState = {
  treeVisible: false,
  collapsedFilePaths: [],
  collapsedFolderPaths: [],
  commitsCollapsed: true,
};
