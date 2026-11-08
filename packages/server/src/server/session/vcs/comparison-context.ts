import { resolve } from "node:path";
import type { VcsBinding, VcsComparisonContext } from "@getpaseo/protocol/vcs";
import type { ProjectRegistry, WorkspaceRegistry } from "../../workspace-registry.js";
import type { WorkspaceRuntimeStore } from "../../workspace-runtime-store/index.js";

// This read must not acquire the VCS executor: a provider can call it while producing a snapshot.
export async function readComparisonContext(
  binding: VcsBinding,
  deps: {
    projects: ProjectRegistry;
    workspaces: WorkspaceRegistry;
    runtime?: WorkspaceRuntimeStore;
  },
): Promise<VcsComparisonContext> {
  const workspaces = (await deps.workspaces.list()).filter(
    (record) => !record.archivedAt && resolve(record.cwd) === resolve(binding.cwd),
  );
  const projects = await deps.projects.list();
  const project = projects.find(
    (record) =>
      !record.archivedAt &&
      record.vcsProviderId === binding.providerId &&
      (resolve(record.rootPath) === resolve(binding.cwd) ||
        workspaces.some((workspace) => workspace.projectId === record.projectId)),
  );
  if (!project)
    return {
      workingCopy: null,
      changeRequest: null,
      changeRequestError: null,
      observedHeadRef: null,
    };
  const workspace = workspaces.find((record) => record.projectId === project.projectId);
  const snapshot = deps.runtime?.get(binding.cwd);
  const request = snapshot?.forge.pullRequest;
  return {
    // COMPAT(vcsLegacyWorkingCopyContext): v0.15.2; normalize pre-provider ownership until 2027-06-06.
    workingCopy:
      workspace?.vcsWorkingCopy ??
      (workspace ? { binding, owned: workspace.isPaseoOwnedWorktree ?? false } : null),
    changeRequest: request
      ? { url: request.url, baseRef: request.baseRefName, headRef: request.headRefName }
      : null,
    changeRequestError: snapshot?.forge.error?.message ?? null,
    observedHeadRef: snapshot?.git.currentBranch ?? null,
  };
}
