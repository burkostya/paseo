import type { VcsInboundMessage } from "@getpaseo/protocol/vcs-rpc";
import { VcsError } from "@getpaseo/plugin/server/vcs";
import type {
  ProjectRegistry,
  WorkspaceRegistry,
  PersistedProjectRecord,
  PersistedWorkspaceRecord,
} from "../../workspace-registry.js";
import { resolveWorkspaceVcsService, type VcsPlugins } from "../../workspace-vcs-service.js";
import { savedVcsComparison, legacyComparisonFields } from "../../vcs-comparison-settings.js";

export async function handleComparisonSettings(
  request: Extract<
    VcsInboundMessage,
    { type: "vcs.comparison.get.request" | "vcs.comparison.set.request" }
  >,
  deps: { plugins: VcsPlugins; projects: ProjectRegistry; workspaces: WorkspaceRegistry },
) {
  const { target, providerId } = request;
  const workspace =
    target.kind === "workspace" ? await deps.workspaces.get(target.workspaceId) : null;
  if (target.kind === "workspace" && !workspace)
    throw new VcsError({ code: "unavailable", message: "Workspace is unavailable" });
  const projectId = target.kind === "project" ? target.projectId : workspace!.projectId;
  const project = await deps.projects.get(projectId);
  if (!project || project.archivedAt || workspace?.archivedAt)
    throw new VcsError({ code: "unavailable", message: "Project or workspace is unavailable" });
  const vcs = resolveWorkspaceVcsService(deps);
  const selected = await vcs.getProjectSelection(projectId);
  if (selected.providerId !== providerId)
    throw new VcsError({
      code: "outdated",
      message: "Project VCS changed; reopen comparison settings",
    });
  function result(
    projectRecord: PersistedProjectRecord,
    workspaceRecord: PersistedWorkspaceRecord | null,
  ) {
    const inherited = workspaceRecord ? savedVcsComparison(projectRecord, providerId) : null;
    const selection = savedVcsComparison(workspaceRecord ?? projectRecord, providerId);
    return { providerId, selection, inherited, effective: selection ?? inherited };
  }
  if (request.type === "vcs.comparison.get.request") return result(project, workspace);
  return vcs.withProjectBinding(
    projectId,
    workspace?.cwd ?? project.rootPath,
    async (currentProject, binding) => {
      if (binding.providerId !== providerId)
        throw new VcsError({ code: "outdated", message: "Project VCS changed" });
      const response = await deps.plugins.invokeVcs(providerId, {
        kind: "comparison-settings.validate",
        binding,
        value: request.value,
      });
      if (response.kind === "error") throw new VcsError(response.error);
      if (response.kind !== "comparison-settings")
        throw new Error("Invalid comparison settings response");
      const value = response.value;
      const patch = <T extends PersistedProjectRecord | PersistedWorkspaceRecord>(
        record: T,
      ): T => ({
        ...record,
        vcsComparisonSettings: { ...record.vcsComparisonSettings, [providerId]: value },
        ...legacyComparisonFields(providerId, value),
        updatedAt: new Date().toISOString(),
      });
      if (target.kind === "project") {
        const updated = await deps.projects.update(projectId, patch);
        if (!updated) throw new Error("Project disappeared while saving comparison settings");
        return result(updated, null);
      }
      const updated = await deps.workspaces.update(target.workspaceId, patch);
      if (!updated) throw new Error("Workspace disappeared while saving comparison settings");
      return result(currentProject, updated);
    },
  );
}
