import type { DiffComparison } from "@getpaseo/protocol/messages";
import type { TFunction } from "i18next";
export function comparisonLabel(comparison: DiffComparison | undefined, t: TFunction): string {
  // COMPAT(workspaceDiffComparison): added in v0.11.0, remove after 2027-04-02 when old hosts no longer omit comparison metadata.
  if (!comparison) return t("workspace.git.diff.openChangesTab");
  return comparison.mode === "base"
    ? t("diffComparison.branch", {
        branch: comparison.baseRef.replace(/^refs\/(heads|remotes)\//, ""),
      })
    : t("diffComparison.uncommitted");
}
