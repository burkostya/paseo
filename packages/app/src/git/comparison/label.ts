import type { DiffComparison, DiffComparisonV2 } from "@getpaseo/protocol/messages";
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

export function comparisonV2Label(
  comparison: DiffComparisonV2 | undefined,
  t: TFunction,
  resolvedBase?: string | null,
): string {
  if (!comparison) return t("workspace.git.diff.openChangesTab");
  if (comparison.mode === "uncommitted") return t("diffComparison.uncommitted");
  const mode = t(
    comparison.mode === "all" ? "workspace.git.diff.all" : "workspace.git.diff.committed",
  );
  const base = comparison.baseRef ?? resolvedBase;
  const branch = base
    ? base.replace(/^refs\/(heads|remotes)\//, "")
    : t("diffComparison.automatic");
  return `${mode} · ${branch}`;
}
