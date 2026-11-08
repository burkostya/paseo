import { mkdir, realpath } from "node:fs/promises";
import { VcsError } from "@getpaseo/plugin/server/vcs";
import { type VcsWorkingCopyCreate } from "@getpaseo/protocol/vcs";
import { seedPaseoConfigFile } from "../../../utils/worktree.js";
import { resolvePaseoHome } from "../../paseo-home.js";
import { getRealpathAwareRelativePath } from "../../../utils/path.js";
import {
  awaitWorkingCopyOperation,
  resolveWorkspaceVcsService,
  type VcsPlugins,
} from "../../workspace-vcs-service.js";
import type { PluginLifecycle } from "../../plugins/lifecycle/index.js";
import { describeHookWorkspace } from "../../plugins/lifecycle/index.js";
import { basename, resolve, join } from "node:path";
import type { ProjectCheckoutLitePayload } from "@getpaseo/protocol/messages";
import type { Logger } from "pino";
import {
  generateWorkspaceId,
  initialWorkspacePlacement,
  reconcileWorkspacePlacement,
} from "../../workspace-registry-model.js";
import {
  createPersistedWorkspaceRecord,
  type PersistedProjectRecord,
  type PersistedWorkspaceRecord,
  type ProjectRegistry,
  type WorkspaceRegistry,
} from "../../workspace-registry.js";
import type { WorkspaceGitService } from "../../workspace-git-service.js";
import type { CreatePaseoWorktreeWorkflowResult } from "../../worktree-session.js";
import { deriveProjectKey } from "../../project-key.js";
import { areEquivalentPaths, createRealpathAwarePathMatcher } from "../../../utils/path.js";
import type { UntrustedWorkspaceSource } from "../../workspace-automation-gate.js";

export interface ResolveOrCreateWorkspaceIdInput {
  createdWorktree: CreatePaseoWorktreeWorkflowResult | null;
  requestedWorkspaceId?: string;
  cwd: string;
  initialTitle: string | null;
  background?: boolean;
  callerWorkspaceId?: string;
}

export interface ImportWorkspaceInput {
  cwd: string;
  requestedWorkspaceId?: string;
}

export interface ImportWorkspaceResult<T> {
  value: T;
  createdWorkspace: PersistedWorkspaceRecord | null;
}

export interface CreateWorktreeWorkspaceInput {
  sourceCwd: string;
  projectId?: string;
  workspaceId?: string;
  repoRoot: string;
  cwd: string;
  worktreeRoot: string;
  branch: string | null;
  baseBranch: string | null;
  title: string | null;
  expectsInitialAgent?: boolean;
  untrustedSource?: UntrustedWorkspaceSource;
  background?: boolean;
  callerWorkspaceId?: string;
}

export interface CreateWorkingCopyWorkspaceInput {
  projectId: string;
  providerId?: string;
  providerData?: VcsWorkingCopyCreate["data"];
  cwd?: string;
  revision?: string;
  workspaceId?: string;
  title?: string | null;
  expectsInitialAgent?: boolean;
  background?: boolean;
  callerWorkspaceId?: string;
}

export interface WorkspaceProvisioningService {
  createWorkspaceForWorkingCopy(
    input: CreateWorkingCopyWorkspaceInput,
  ): Promise<PersistedWorkspaceRecord>;
  runInImportWorkspace<T>(
    input: ImportWorkspaceInput,
    operation: (workspace: PersistedWorkspaceRecord) => Promise<T>,
  ): Promise<ImportWorkspaceResult<T>>;
  findOrCreateWorkspaceForDirectory(cwd: string): Promise<PersistedWorkspaceRecord>;
  resolveOrCreateWorkspaceIdForCreateAgent(input: ResolveOrCreateWorkspaceIdInput): Promise<string>;
  createWorkspaceForDirectory(
    cwd: string,
    title?: string | null,
    projectId?: string,
    context?: {
      expectsInitialAgent?: boolean;
      workspaceId?: string;
      background?: boolean;
      callerWorkspaceId?: string;
    },
  ): Promise<PersistedWorkspaceRecord>;
  createWorkspaceForWorktree(
    input: CreateWorktreeWorkspaceInput,
  ): Promise<PersistedWorkspaceRecord>;
  findOrCreateProjectForDirectory(cwd: string): Promise<PersistedProjectRecord>;
  ensureWorkspaceRecordUnarchived(
    workspace: PersistedWorkspaceRecord,
  ): Promise<PersistedWorkspaceRecord>;
}

export type WorkspaceProvisioningErrorCode = "unknown_project" | "archived_project";

export class WorkspaceProvisioningError extends Error {
  constructor(
    readonly code: WorkspaceProvisioningErrorCode,
    projectId: string,
  ) {
    super(
      code === "unknown_project"
        ? `Unknown project: ${projectId}`
        : `Archived project: ${projectId}`,
    );
    this.name = "WorkspaceProvisioningError";
  }
}

export function createWorkspaceProvisioningService(deps: {
  serverId?: string;
  paseoHome?: string;
  workspaceRegistry: WorkspaceRegistry;
  projectRegistry: ProjectRegistry;
  workspaceGitService: Pick<WorkspaceGitService, "getCheckout" | "getSnapshot">;
  isDirectory: (path: string) => Promise<boolean>;
  logger: Logger;
  lifecycle?: PluginLifecycle;
  vcsPlugins?: VcsPlugins;
}): WorkspaceProvisioningService {
  const { serverId, workspaceRegistry, projectRegistry, workspaceGitService, logger } = deps;
  const vcs = deps.vcsPlugins
    ? resolveWorkspaceVcsService({
        projects: projectRegistry,
        workspaces: workspaceRegistry,
        plugins: deps.vcsPlugins,
      })
    : undefined;

  /**
   * Placement facts at a workspace directory, or null when there is nothing
   * there to read. A git read answers "not a checkout" for a plain directory
   * and for a directory that is gone, and only the first is evidence that a
   * worktree stopped being one. That answer therefore counts only while the
   * directory is there on both sides of the read, so a worktree removed or
   * unmounted while the read is in flight stays an absence.
   */
  async function observeWorkspaceCheckout(cwd: string): Promise<ProjectCheckoutLitePayload | null> {
    if (!(await deps.isDirectory(cwd))) return null;
    const checkout = await workspaceGitService.getCheckout(cwd);
    if (!checkout.isGit && !(await deps.isDirectory(cwd))) return null;
    return checkout;
  }

  async function runInImportWorkspace<T>(
    input: ImportWorkspaceInput,
    operation: (workspace: PersistedWorkspaceRecord) => Promise<T>,
  ): Promise<ImportWorkspaceResult<T>> {
    if (input.requestedWorkspaceId) {
      const workspace = await workspaceRegistry.get(input.requestedWorkspaceId);
      if (!workspace || workspace.archivedAt) {
        throw new Error(`Workspace not found: ${input.requestedWorkspaceId}`);
      }
      const project = await projectRegistry.get(workspace.projectId);
      if (!project || project.archivedAt) {
        throw new Error(`Project not found: ${workspace.projectId}`);
      }
      if (!createRealpathAwarePathMatcher(workspace.cwd)(input.cwd)) {
        throw new Error(`Import cwd does not match workspace: ${workspace.workspaceId}`);
      }
      return {
        value: await operation(workspace),
        createdWorkspace: null,
      };
    }

    const [projectsBeforeImport, workspacesBeforeImport] = await Promise.all([
      projectRegistry.list(),
      workspaceRegistry.list(),
    ]);
    const workspace = await findOrCreateWorkspaceForDirectory(input.cwd);
    const createdWorkspace = workspacesBeforeImport.some(
      (candidate) => candidate.workspaceId === workspace.workspaceId,
    )
      ? null
      : workspace;
    const previousProject =
      projectsBeforeImport.find((project) => project.projectId === workspace.projectId) ?? null;

    try {
      return {
        value: await operation(workspace),
        createdWorkspace,
      };
    } catch (error) {
      if (createdWorkspace) {
        await rollbackFailedImportWorkspace(createdWorkspace, previousProject);
      }
      throw error;
    }
  }

  async function rollbackFailedImportWorkspace(
    workspace: PersistedWorkspaceRecord,
    previousProject: PersistedProjectRecord | null,
  ): Promise<void> {
    try {
      await workspaceRegistry.remove(workspace.workspaceId);
      const projectHasActiveWorkspace = (await workspaceRegistry.list()).some(
        (candidate) => candidate.projectId === workspace.projectId && !candidate.archivedAt,
      );
      if (projectHasActiveWorkspace) {
        return;
      }
      if (previousProject?.archivedAt) {
        await projectRegistry.upsert(previousProject);
      } else if (!previousProject) {
        await projectRegistry.remove(workspace.projectId);
      }
    } catch (error) {
      logger.error(
        { err: error, workspaceId: workspace.workspaceId, projectId: workspace.projectId },
        "Failed to restore workspace state after provider import failure",
      );
    }
  }

  async function findOrCreateProjectForDirectory(cwd: string): Promise<PersistedProjectRecord> {
    const rootPath = resolve(cwd);
    const checkout = await workspaceGitService.getCheckout(rootPath);
    const timestamp = new Date().toISOString();
    const project = await projectRegistry.getOrCreateActiveByRoot({
      rootPath,
      kind: checkout.isGit ? "git" : "non_git",
      displayName: basename(rootPath) || rootPath,
      projectKey: deriveProjectKey({
        rootPath,
        remoteUrl: checkout.remoteUrl,
        worktreeRoot: checkout.worktreeRoot,
        mainRepoRoot: checkout.mainRepoRoot,
        serverId,
      }),
      timestamp,
    });
    if (vcs) await vcs.getProjectSelection(project.projectId);
    return (await projectRegistry.get(project.projectId)) ?? project;
  }

  async function requireActiveProject(projectId: string): Promise<PersistedProjectRecord> {
    const project = await projectRegistry.get(projectId);
    if (!project) throw new WorkspaceProvisioningError("unknown_project", projectId);
    if (project.archivedAt) throw new WorkspaceProvisioningError("archived_project", projectId);
    return project;
  }

  async function resolveBackground(input?: {
    background?: boolean;
    callerWorkspaceId?: string;
  }): Promise<boolean> {
    if (input?.background !== undefined) return input.background;
    if (!input?.callerWorkspaceId) return false;
    const callerWorkspace = await workspaceRegistry.get(input.callerWorkspaceId);
    if (!callerWorkspace) throw new Error(`Caller workspace ${input.callerWorkspaceId} not found`);
    return callerWorkspace.background;
  }

  async function createWorkspaceForDirectory(
    cwd: string,
    title?: string | null,
    projectId?: string,
    context?: {
      expectsInitialAgent?: boolean;
      workspaceId?: string;
      background?: boolean;
      callerWorkspaceId?: string;
    },
  ): Promise<PersistedWorkspaceRecord> {
    const normalizedCwd = resolve(cwd);
    const checkout = await workspaceGitService.getCheckout(normalizedCwd);
    const project = projectId
      ? await refreshProjectKind(await requireActiveProject(projectId), normalizedCwd, checkout)
      : // COMPAT(workspaceCreateMissingProjectId): added in v0.1.107, remove after 2027-01-15.
        await findOrCreateProjectForDirectory(normalizedCwd);
    const timestamp = new Date().toISOString();
    let workspace = createPersistedWorkspaceRecord({
      workspaceId: context?.workspaceId ?? generateWorkspaceId(),
      projectId: project.projectId,
      ...initialWorkspacePlacement({ source: "checkout", cwd: normalizedCwd, checkout }),
      title: title?.trim() || null,
      createdAt: timestamp,
      updatedAt: timestamp,
      background: await resolveBackground(context),
    });
    if (vcs)
      workspace = await vcs.persistWorkspace(workspace, {
        expectsInitialAgent: context?.expectsInitialAgent,
      });
    else
      await workspaceRegistry.upsert(workspace, {
        expectsInitialAgent: context?.expectsInitialAgent,
      });
    emitWorkspaceCreated(workspace);
    return workspace;
  }

  async function createWorkspaceForWorkingCopy(
    input: CreateWorkingCopyWorkspaceInput,
  ): Promise<PersistedWorkspaceRecord> {
    const plugins = deps.vcsPlugins;
    if (!vcs || !plugins)
      throw new VcsError({ code: "unavailable", message: "VCS providers are unavailable" });
    const project = await requireActiveProject(input.projectId);
    const cwd = resolve(input.cwd ?? project.rootPath);
    const workspaceId = input.workspaceId ?? generateWorkspaceId();
    if (!/^wks_[a-f0-9]{16}$/.test(workspaceId)) throw new Error("Invalid workspace ID");
    const background = await resolveBackground(input);
    // Keep neutral copies outside the path-based ownership rules of the legacy Git sweeper.
    const parent = resolve(
      deps.paseoHome ?? resolvePaseoHome(),
      "working-copies",
      project.projectId,
    );
    await mkdir(parent, { recursive: true });
    const root = join(await realpath(parent), workspaceId);
    return vcs.withProjectBinding(project.projectId, cwd, async (selected, binding) => {
      if (input.providerId && input.providerId !== binding.providerId)
        throw new VcsError({
          code: "outdated",
          message: "Project VCS changed; reopen working-copy creation",
        });
      if (await workspaceRegistry.get(workspaceId))
        throw new Error(`Workspace already exists: ${workspaceId}`);
      const relativeCwd = getRealpathAwareRelativePath(binding.root, cwd);
      if (relativeCwd === null) throw new Error("Workspace directory is outside its working copy");
      const snapshot = await plugins.invokeVcs(binding.providerId, { kind: "snapshot", binding });
      if (snapshot.kind !== "snapshot") throw new Error("Invalid VCS snapshot response");
      const revision = input.revision ?? snapshot.snapshot.current?.id;
      if (!revision) throw new Error("Select a revision before creating a working copy");
      let creation: VcsWorkingCopyCreate = {
        root,
        name: workspaceId,
        revision,
        data: input.providerData,
      };
      if (deps.lifecycle)
        creation = (
          await deps.lifecycle.before("working-copy.create.before", { binding, input: creation })
        ).input;
      const operationId = JSON.stringify(["working-copy.create", workspaceId]);
      const response = await plugins.invokeVcs(binding.providerId, {
        kind: "execute",
        binding,
        operationId,
        version: snapshot.snapshot.version,
        action: "working-copy.create",
        input: creation,
      });
      const record = await awaitWorkingCopyOperation({
        plugins,
        providerId: binding.providerId,
        response,
      });
      if (
        !record.owned ||
        record.binding.root !== root ||
        record.binding.cwd !== root ||
        record.binding.providerId !== binding.providerId ||
        record.binding.repositoryId !== binding.repositoryId
      )
        throw new Error("Provider returned an invalid created working copy");
      try {
        await deps.lifecycle?.wait("working-copy.create.after", {
          source: binding,
          workingCopy: record,
        });
        const workspaceCwd = join(root, relativeCwd);
        if (!(await deps.isDirectory(workspaceCwd)))
          throw new Error(
            `Selected project directory is missing from the working copy: ${workspaceCwd}`,
          );
        await seedPaseoConfigFile({ sourceCwd: cwd, targetCwd: workspaceCwd });
        const timestamp = new Date().toISOString();
        const workspace = createPersistedWorkspaceRecord({
          workspaceId,
          projectId: project.projectId,
          cwd: workspaceCwd,
          kind: "directory",
          displayName: basename(root),
          title: input.title,
          vcsBinding: { ...record.binding, cwd: workspaceCwd },
          vcsWorkingCopy: {
            ...record,
            source: binding,
            binding: { ...record.binding, cwd: workspaceCwd },
          },
          vcsBindingRevision: selected.vcsSelectionRevision,
          background,
          createdAt: timestamp,
          updatedAt: timestamp,
        });
        await workspaceRegistry.upsert(workspace, {
          expectsInitialAgent: input.expectsInitialAgent,
        });
        emitWorkspaceCreated(workspace);
        return workspace;
      } catch (error) {
        try {
          await plugins.invokeVcs(binding.providerId, {
            kind: "working-copy.rollback",
            binding,
            record,
          });
        } catch (rollbackError) {
          const creationFailure = error instanceof Error ? error.message : String(error);
          throw new Error(
            `Working copy creation failed: ${creationFailure}. Cleanup failed for ${root}; inspect the working copy before retrying`,
            {
              cause: rollbackError,
            },
          );
        }
        throw error;
      }
    });
  }

  async function createWorkspaceForWorktree(
    input: CreateWorktreeWorkspaceInput,
  ): Promise<PersistedWorkspaceRecord> {
    const sourceCwd = resolve(input.sourceCwd);
    const repoRoot = resolve(input.repoRoot);
    const cwd = resolve(input.cwd);
    const worktreeRoot = resolve(input.worktreeRoot);
    const project = await resolveSourceProjectForWorktree({
      sourceCwd,
      projectId: input.projectId,
      repoRoot,
    });
    const providerId = vcs ? (await vcs.getProjectSelection(project.projectId)).providerId : null;
    if (providerId && providerId !== "git")
      throw new Error("Selected VCS does not support legacy Git worktree creation");
    const timestamp = new Date().toISOString();
    let workspace = createPersistedWorkspaceRecord({
      workspaceId: input.workspaceId ?? generateWorkspaceId(),
      projectId: project.projectId,
      ...initialWorkspacePlacement({
        source: "created_worktree",
        cwd,
        worktreeRoot,
        branch: input.branch,
        baseBranch: input.baseBranch,
        mainRepoRoot: repoRoot,
      }),
      title: input.title,
      createdAt: timestamp,
      updatedAt: timestamp,
      ...(input.untrustedSource ? { untrustedSource: input.untrustedSource } : {}),
      background: await resolveBackground(input),
    });
    if (vcs)
      workspace = await vcs.persistWorkspace(workspace, {
        expectsInitialAgent: input.expectsInitialAgent,
      });
    else
      await workspaceRegistry.upsert(workspace, { expectsInitialAgent: input.expectsInitialAgent });
    emitWorkspaceCreated(workspace);
    return workspace;
  }

  function emitWorkspaceCreated(workspace: PersistedWorkspaceRecord): void {
    deps.lifecycle?.emit("workspace.create.after", {
      workspace: describeHookWorkspace(workspace),
    });
  }

  async function resolveSourceProjectForWorktree(input: {
    sourceCwd: string;
    projectId?: string;
    repoRoot: string;
  }): Promise<PersistedProjectRecord> {
    if (input.projectId) {
      return refreshProjectKind(await requireActiveProject(input.projectId));
    }

    const workspaces = await workspaceRegistry.list();
    const sourceWorkspace =
      workspaces.find(
        (workspace) => !workspace.archivedAt && areEquivalentPaths(workspace.cwd, input.sourceCwd),
      ) ??
      workspaces.find(
        (workspace) => !workspace.archivedAt && areEquivalentPaths(workspace.cwd, input.repoRoot),
      );
    if (sourceWorkspace) {
      const project = await projectRegistry.get(sourceWorkspace.projectId);
      if (project) return refreshProjectKind(project);
      // COMPAT(worktreeMissingSourceProject): added in v0.1.107, remove after 2027-01-15.
      // Orphaned legacy workspace FKs fall through to exact-root allocation.
    }

    const checkout = await workspaceGitService.getCheckout(input.repoRoot);
    const project = await projectRegistry.getOrCreateActiveByRoot({
      rootPath: input.repoRoot,
      kind: "git",
      displayName: basename(input.repoRoot) || input.repoRoot,
      projectKey: deriveProjectKey({
        rootPath: input.repoRoot,
        remoteUrl: checkout.remoteUrl,
        worktreeRoot: checkout.worktreeRoot,
        mainRepoRoot: checkout.mainRepoRoot,
        serverId,
      }),
      timestamp: new Date().toISOString(),
    });
    return refreshProjectKind(project);
  }

  async function findOrCreateWorkspaceForDirectory(cwd: string): Promise<PersistedWorkspaceRecord> {
    const normalizedCwd = resolve(cwd);
    // Path-based discovery selects public work; explicit-ID recovery bypasses this selector.
    const workspaces = (await workspaceRegistry.list())
      .filter(
        (workspace) => !workspace.background && areEquivalentPaths(workspace.cwd, normalizedCwd),
      )
      .sort(
        (left, right) =>
          Date.parse(left.createdAt) - Date.parse(right.createdAt) ||
          left.workspaceId.localeCompare(right.workspaceId),
      );
    const active = workspaces.find((workspace) => !workspace.archivedAt);
    if (active) return refreshWorkspaceRecord(active);
    const archived = workspaces.find((workspace) => workspace.archivedAt);
    if (archived) {
      const project = await projectRegistry.get(archived.projectId);
      if (project && !project.archivedAt) return ensureWorkspaceRecordUnarchived(archived);
    }
    return createWorkspaceForDirectory(normalizedCwd);
  }

  async function resolveOrCreateWorkspaceIdForCreateAgent(
    input: ResolveOrCreateWorkspaceIdInput,
  ): Promise<string> {
    if (input.createdWorktree) return input.createdWorktree.workspace.workspaceId;
    if (input.requestedWorkspaceId) return input.requestedWorkspaceId;
    return (
      await createWorkspaceForDirectory(input.cwd, input.initialTitle, undefined, {
        expectsInitialAgent: true,
        background: input.background,
        callerWorkspaceId: input.callerWorkspaceId,
      })
    ).workspaceId;
  }

  async function resolveRestoredAutoArchiveChangeRequestUrl(
    workspace: PersistedWorkspaceRecord,
  ): Promise<string | null> {
    if (!workspace.archivedAt) {
      return workspace.autoArchivedChangeRequestUrl;
    }
    const snapshot = await workspaceGitService.getSnapshot(workspace.cwd, {
      force: true,
      includeForge: true,
      reason: "workspace-restore-auto-archive-latch",
    });
    return snapshot.forge.pullRequest?.isMerged
      ? snapshot.forge.pullRequest.url
      : workspace.autoArchivedChangeRequestUrl;
  }

  async function ensureWorkspaceRecordUnarchived(
    workspace: PersistedWorkspaceRecord,
  ): Promise<PersistedWorkspaceRecord> {
    const project = await projectRegistry.get(workspace.projectId);
    if (!project) throw new Error(`Unknown project: ${workspace.projectId}`);
    const timestamp = new Date().toISOString();
    const checkout =
      workspace.archivedAt || project.archivedAt
        ? await observeWorkspaceCheckout(workspace.cwd)
        : null;
    const autoArchivedChangeRequestUrl =
      await resolveRestoredAutoArchiveChangeRequestUrl(workspace);
    let next: PersistedWorkspaceRecord | null = null;
    if (workspace.archivedAt) {
      const placementUpdate = reconcileWorkspacePlacement({
        workspace,
        checkout,
        updatedAt: timestamp,
      });
      next = {
        ...(placementUpdate?.workspace ?? workspace),
        archivedAt: null,
        autoArchivedChangeRequestUrl,
        updatedAt: timestamp,
      };
    }
    if (project.archivedAt || workspace.archivedAt) {
      const projectCheckout =
        checkout && areEquivalentPaths(project.rootPath, workspace.cwd)
          ? checkout
          : await workspaceGitService.getCheckout(project.rootPath);
      const kind = projectCheckout.isGit ? "git" : "non_git";
      const projectKey = deriveProjectKey({
        rootPath: project.rootPath,
        remoteUrl: projectCheckout.remoteUrl,
        worktreeRoot: projectCheckout.worktreeRoot,
        mainRepoRoot: projectCheckout.mainRepoRoot,
        serverId,
      });
      if (project.archivedAt || project.kind !== kind || project.projectKey !== projectKey) {
        await projectRegistry.update(project.projectId, (current) => ({
          ...current,
          kind,
          projectKey,
          archivedAt: null,
          updatedAt: timestamp,
        }));
      }
    }
    if (!next) return workspace;
    if (vcs) next = await vcs.persistWorkspace(next);
    else await workspaceRegistry.upsert(next);
    return next;
  }

  async function refreshWorkspaceRecord(
    workspace: PersistedWorkspaceRecord,
  ): Promise<PersistedWorkspaceRecord> {
    const checkout = await observeWorkspaceCheckout(workspace.cwd);
    const project = await projectRegistry.get(workspace.projectId);
    if (project && !project.archivedAt) {
      await refreshProjectKind(project, workspace.cwd, checkout ?? undefined);
    }
    const update = reconcileWorkspacePlacement({
      workspace,
      checkout,
      updatedAt: new Date().toISOString(),
    });
    if (!update) return workspace;
    const refreshed = await workspaceRegistry.update(workspace.workspaceId, (current) => ({
      ...current,
      ...update.fields,
      updatedAt: update.workspace.updatedAt,
    }));
    if (!refreshed)
      throw new Error(`Workspace disappeared during refresh: ${workspace.workspaceId}`);
    return refreshed;
  }

  async function refreshProjectKind(
    project: PersistedProjectRecord,
    workspaceCwd?: string,
    workspaceCheckout?: Awaited<ReturnType<WorkspaceGitService["getCheckout"]>>,
  ): Promise<PersistedProjectRecord> {
    const projectCheckout =
      workspaceCwd && workspaceCheckout && areEquivalentPaths(project.rootPath, workspaceCwd)
        ? workspaceCheckout
        : await workspaceGitService.getCheckout(project.rootPath);
    const kind: PersistedProjectRecord["kind"] = projectCheckout.isGit ? "git" : "non_git";
    const projectKey = deriveProjectKey({
      rootPath: project.rootPath,
      remoteUrl: projectCheckout.remoteUrl,
      worktreeRoot: projectCheckout.worktreeRoot,
      mainRepoRoot: projectCheckout.mainRepoRoot,
      serverId,
    });
    if (project.kind === kind && project.projectKey === projectKey) return project;
    const refreshed = {
      ...project,
      kind,
      projectKey,
      updatedAt: new Date().toISOString(),
    };
    return (
      (await projectRegistry.update(project.projectId, (current) => ({
        ...current,
        kind,
        projectKey,
        updatedAt: refreshed.updatedAt,
      }))) ?? refreshed
    );
  }

  return {
    createWorkspaceForWorkingCopy,
    runInImportWorkspace,
    findOrCreateWorkspaceForDirectory,
    resolveOrCreateWorkspaceIdForCreateAgent,
    createWorkspaceForDirectory,
    createWorkspaceForWorktree,
    findOrCreateProjectForDirectory,
    ensureWorkspaceRecordUnarchived,
  };
}
