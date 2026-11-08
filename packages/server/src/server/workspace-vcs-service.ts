import type { ForgeResolver } from "../services/forge-resolver.js";
import { WorkspacePublicationService } from "./workspace-publication-service.js";
import { lstat } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { getRealpathAwareRelativePath } from "../utils/path.js";
import {
  VcsWorkingCopyRecordSchema,
  type VcsWorkingCopyRecord,
  type VcsRecoveryOperation,
  type VcsResponse,
  type VcsProblem,
} from "@getpaseo/protocol/vcs";
import { resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { VcsError } from "@getpaseo/plugin/server/vcs";
import type { VcsBinding, VcsDetection, VcsOperation } from "@getpaseo/protocol/vcs";
import type { PluginService } from "./plugins/index.js";
import type {
  ProjectRegistry,
  WorkspaceRegistry,
  PersistedProjectRecord,
  PersistedWorkspaceRecord,
  WorkspaceMutationContext,
} from "./workspace-registry.js";

export type VcsPlugins = Pick<PluginService, "listVcsProviders" | "invokeVcs"> &
  Partial<Pick<PluginService, "subscribe">>;
interface Dependencies {
  forge?: ForgeResolver;
  projects: ProjectRegistry;
  workspaces: WorkspaceRegistry;
  plugins: VcsPlugins;
}

// Provisioning and every session share the registry's project lock, including across reconnects.
const services = new WeakMap<WorkspaceRegistry, WorkspaceVcsService>();
export function resolveWorkspaceVcsService(deps: Dependencies): WorkspaceVcsService {
  let service = services.get(deps.workspaces);
  if (!service) {
    service = new WorkspaceVcsService(deps);
    services.set(deps.workspaces, service);
  }
  return service;
}
export async function awaitWorkingCopyOperation(input: {
  plugins: VcsPlugins;
  providerId: string;
  response: VcsResponse;
}): Promise<VcsWorkingCopyRecord> {
  let response = input.response;
  if (response.kind !== "operation") throw new Error("Invalid VCS working-copy operation response");
  while (response.operation.status === "pending" || response.operation.status === "running") {
    await delay(25);
    response = await input.plugins.invokeVcs(input.providerId, {
      kind: "operation",
      operationId: response.operation.id,
    });
    if (response.kind !== "operation") throw new Error("Invalid VCS operation response");
  }
  if (response.operation.status !== "succeeded")
    throw new VcsError(
      response.operation.error ?? {
        code: "provider",
        message: "Working-copy operation has an unknown outcome; refresh before retrying",
      },
    );
  return VcsWorkingCopyRecordSchema.parse(response.operation.result);
}
function problem(error: unknown): VcsProblem {
  return error instanceof VcsError
    ? error.problem
    : { code: "provider", message: error instanceof Error ? error.message : String(error) };
}
async function pathExists(root: string): Promise<boolean> {
  try {
    await lstat(root);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}
function references(root: string, workspace: PersistedWorkspaceRecord): boolean {
  return getRealpathAwareRelativePath(root, workspace.cwd) !== null;
}
export interface WorkingCopyArchiveResult {
  removedDirectory: boolean;
  directoryLeftBehind?: { path: string; reason: string };
}
export class WorkspaceVcsService {
  private readonly legacyOperations = new Map<string, number>();
  private readonly pendingOperations = new Map<string, Map<string, string>>();
  private readonly queues = new Map<string, Promise<unknown>>();
  private lifecycleQueue: Promise<unknown> = Promise.resolve();
  private readonly pendingRestores = new Set<string>();
  readonly publication: WorkspacePublicationService;
  constructor(private readonly deps: Dependencies) {
    this.publication = new WorkspacePublicationService({
      vcs: this,
      plugins: deps.plugins,
      forge: deps.forge,
    });
  }
  private lifecycle<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.lifecycleQueue.catch(() => {}).then(operation);
    this.lifecycleQueue = result;
    return result;
  }
  private async recovery(
    record: VcsWorkingCopyRecord,
    operation: VcsRecoveryOperation,
  ): Promise<VcsWorkingCopyRecord> {
    const response = await this.deps.plugins.invokeVcs(record.binding.providerId, {
      kind: "working-copy.recovery",
      operation,
      record,
      operationId: randomUUID(),
    });
    const next = await awaitWorkingCopyOperation({
      plugins: this.deps.plugins,
      providerId: record.binding.providerId,
      response,
    });
    if (
      !next.owned ||
      next.binding.root !== record.binding.root ||
      next.binding.providerId !== record.binding.providerId ||
      next.binding.repositoryId !== record.binding.repositoryId ||
      next.binding.workingCopyId !== record.binding.workingCopyId
    )
      throw new Error("Provider changed the working-copy identity during recovery");
    return next;
  }
  private async saveShared(record: VcsWorkingCopyRecord): Promise<void> {
    const records = await this.deps.workspaces.list();
    for (const workspace of records) {
      if (!references(record.binding.root, workspace)) continue;
      if (workspace.vcsWorkingCopy && workspace.vcsWorkingCopy.binding.root !== record.binding.root)
        continue;
      await this.deps.workspaces.update(workspace.workspaceId, (current) => ({
        ...current,
        vcsWorkingCopy: { ...record, binding: { ...record.binding, cwd: current.cwd } },
      }));
    }
  }
  async inspectWorkingCopy(workspaceId: string): Promise<void> {
    const workspace = await this.deps.workspaces.get(workspaceId);
    if (!workspace?.vcsWorkingCopy)
      throw new VcsError({ code: "unavailable", message: "No working-copy recovery record" });
    const record = workspace.vcsWorkingCopy;
    if (record.state === "restoring" && (await pathExists(record.binding.root)))
      throw new VcsError({
        code: "outdated",
        message:
          "A previous restore did not finish; move the partial directory aside before retrying",
      });
    await this.deps.plugins.invokeVcs(record.binding.providerId, {
      kind: "working-copy.inspect",
      record,
    });
  }
  async archiveWorkingCopy(
    workspaceId: string,
    teardown: (record: VcsWorkingCopyRecord) => Promise<void>,
  ): Promise<WorkingCopyArchiveResult> {
    return this.lifecycle(async () => {
      const workspace = await this.deps.workspaces.get(workspaceId);
      if (!workspace?.vcsWorkingCopy) throw new Error("Working-copy record is unavailable");
      return this.serial(workspace.projectId, async () => {
        let record = workspace.vcsWorkingCopy!;
        if (!record.owned) return { removedDirectory: false };
        if (record.state === "restoring" || this.pendingRestores.has(workspace.projectId))
          return {
            removedDirectory: false,
            directoryLeftBehind: {
              path: record.binding.root,
              reason: "Restore is incomplete; working copy retained",
            },
          };
        if (!(await pathExists(record.binding.root))) return { removedDirectory: false };
        try {
          await this.assertNoPendingOperations(workspace.projectId);
          await this.saveShared(record);
          await teardown(record);
          const active = (await this.deps.workspaces.list()).filter(
            (entry) => !entry.archivedAt && references(record.binding.root, entry),
          );
          if (active.length) return { removedDirectory: false };
          const previous = record;
          record = { ...(await this.recovery(record, "prepare-removal")), state: "prepared" };
          if (!record.recovery) throw new Error("Provider did not prepare durable recovery data");
          await this.saveShared(record);
          if (previous.recovery) await this.recovery(previous, "release");
          await this.recovery(record, "remove");
          return { removedDirectory: true };
        } catch (error) {
          const diagnostic = problem(error);
          record = { ...record, recoveryError: diagnostic };
          try {
            await this.saveShared(record);
          } catch (writeError) {
            return {
              removedDirectory: false,
              directoryLeftBehind: {
                path: record.binding.root,
                reason: `${diagnostic.message}; recovery diagnostics could not be saved: ${problem(writeError).message}`,
              },
            };
          }
          return {
            removedDirectory: false,
            directoryLeftBehind: { path: record.binding.root, reason: diagnostic.message },
          };
        }
      });
    });
  }
  async restoreWorkingCopy(workspaceId: string): Promise<PersistedWorkspaceRecord> {
    return this.lifecycle(async () => {
      const workspace = await this.deps.workspaces.get(workspaceId);
      if (!workspace?.vcsWorkingCopy) throw new Error("Working-copy record is unavailable");
      return this.serial(workspace.projectId, async () => {
        let record = workspace.vcsWorkingCopy!;
        this.pendingRestores.add(workspace.projectId);
        try {
          if (record.state === "restoring" && (await pathExists(record.binding.root)))
            throw new VcsError({
              code: "outdated",
              message:
                "A previous restore did not finish; move the partial directory aside before retrying",
            });
          if (!(await pathExists(record.binding.root))) {
            record = { ...record, state: "restoring" };
            await this.saveShared(record);
          }
          const restored: VcsWorkingCopyRecord = {
            ...(await this.recovery(record, "restore")),
            state: "restored",
          };
          if (!(await pathExists(workspace.cwd)))
            throw new Error(
              `Restored working copy is missing the workspace directory: ${workspace.cwd}`,
            );
          await this.saveShared(restored);
          return { ...workspace, vcsWorkingCopy: restored };
        } catch (error) {
          this.pendingRestores.delete(workspace.projectId);
          await this.saveShared({ ...record, recoveryError: problem(error) });
          throw error;
        }
      });
    });
  }
  async finishWorkingCopyRestore(workspaceId: string, error?: unknown): Promise<void> {
    await this.lifecycle(async () => {
      const workspace = await this.deps.workspaces.get(workspaceId);
      if (!workspace?.vcsWorkingCopy) return;
      const record = workspace.vcsWorkingCopy;
      try {
        if (error !== undefined) {
          await this.saveShared({ ...record, recoveryError: problem(error) });
          return;
        }
        if (workspace.archivedAt) return;
        const released = record.recovery ? await this.recovery(record, "release") : record;
        await this.saveShared({ ...released, state: "present", recoveryError: undefined });
      } catch (failure) {
        await this.saveShared({ ...record, recoveryError: problem(failure) });
        throw failure;
      } finally {
        this.pendingRestores.delete(workspace.projectId);
      }
    });
  }
  private serial<T>(projectId: string, operation: () => Promise<T>): Promise<T> {
    const result = (this.queues.get(projectId) ?? Promise.resolve())
      .catch(() => {})
      .then(operation);
    this.queues.set(projectId, result);
    void result
      .finally(() => {
        if (this.queues.get(projectId) === result) this.queues.delete(projectId);
      })
      .catch(() => {});
    return result;
  }
  trackOperation(projectId: string, providerId: string, operation: VcsOperation): void {
    const key = JSON.stringify([providerId, operation.id]);
    const pending = this.pendingOperations.get(projectId) ?? new Map<string, string>();
    if (operation.status === "pending" || operation.status === "running")
      pending.set(key, providerId);
    else pending.delete(key);
    if (pending.size) this.pendingOperations.set(projectId, pending);
    else this.pendingOperations.delete(projectId);
  }
  async assertNoPendingOperations(projectId: string): Promise<void> {
    if (this.legacyOperations.has(projectId))
      throw new VcsError({
        code: "outdated",
        message: "Wait for running Git operations before switching providers",
      });
    for (const [key, providerId] of this.pendingOperations.get(projectId) ?? []) {
      const [, id] = JSON.parse(key) as [string, string];
      const hostOperation = this.publication.lookup(providerId, id);
      const response = hostOperation
        ? { kind: "operation" as const, operation: hostOperation }
        : await this.deps.plugins.invokeVcs(providerId, {
            kind: "operation",
            operationId: id,
          });
      if (response.kind !== "operation") throw new Error("Invalid VCS operation response");
      if (response.operation.status === "pending" || response.operation.status === "running")
        throw new VcsError({
          code: "outdated",
          message: "Wait for running VCS operations before switching providers",
        });
      this.trackOperation(projectId, providerId, response.operation);
    }
  }
  async runLegacyGit<T>(cwd: string, operation: () => Promise<T>): Promise<T> {
    const target = resolve(cwd);
    const contains = (root: string) =>
      target === resolve(root) || target.startsWith(resolve(root) + sep);
    const workspace = (await this.deps.workspaces.list())
      .filter(
        (entry) =>
          !entry.archivedAt &&
          (contains(entry.cwd) || (entry.vcsBinding && contains(entry.vcsBinding.root))),
      )
      .sort((a, b) => b.cwd.length - a.cwd.length)[0];
    const project = workspace
      ? await this.project(workspace.projectId)
      : (await this.deps.projects.list())
          .filter((entry) => !entry.archivedAt && contains(entry.rootPath))
          .sort((a, b) => b.rootPath.length - a.rootPath.length)[0];
    if (!project) return operation();
    await this.serial(project.projectId, async () => {
      const selected = await this.project(project.projectId);
      if (selected.vcsProviderId && selected.vcsProviderId !== "git")
        throw new VcsError({
          code: "unavailable",
          message: `Project uses ${selected.vcsProviderId}; use its VCS actions instead of Git operations`,
        });
      this.legacyOperations.set(
        project.projectId,
        (this.legacyOperations.get(project.projectId) ?? 0) + 1,
      );
    });
    try {
      return await operation();
    } finally {
      const remaining = this.legacyOperations.get(project.projectId)! - 1;
      if (remaining) this.legacyOperations.set(project.projectId, remaining);
      else this.legacyOperations.delete(project.projectId);
    }
  }
  private async project(projectId: string): Promise<PersistedProjectRecord> {
    const project = await this.deps.projects.get(projectId);
    if (!project)
      throw new VcsError({ code: "unavailable", message: `Unknown project: ${projectId}` });
    return project;
  }
  private async detect(providerId: string, cwd: string): Promise<VcsDetection> {
    try {
      const result = await this.deps.plugins.invokeVcs(providerId, { kind: "detect", cwd });
      if (result.kind !== "detect") throw new Error("Invalid VCS detection response");
      if (
        result.detection.status === "available" &&
        (result.detection.binding.providerId !== providerId || result.detection.binding.cwd !== cwd)
      )
        throw new Error("Invalid VCS binding");
      return result.detection;
    } catch (error) {
      return {
        status: "unavailable",
        error:
          error instanceof VcsError
            ? error.problem
            : { code: "provider", message: error instanceof Error ? error.message : String(error) },
      };
    }
  }

  private async selected(projectId: string): Promise<PersistedProjectRecord> {
    const project = await this.project(projectId);
    if (project.vcsProviderId !== undefined) return project;
    const providers = this.deps.plugins
      .listVcsProviders()
      .sort(
        (a, b) =>
          (b.detectionPriority ?? 0) - (a.detectionPriority ?? 0) || a.id.localeCompare(b.id),
      );
    for (const provider of providers) {
      const detection = await this.detect(provider.id, project.rootPath);
      if (detection.status === "absent") continue;
      // Even an unavailable executable owns its recognized repository; never fall through to Git.
      const updated = await this.deps.projects.update(projectId, (current) => ({
        ...current,
        vcsProviderId: current.vcsProviderId ?? provider.id,
        vcsSelectionRevision: current.vcsSelectionRevision ?? randomUUID(),
        updatedAt: new Date().toISOString(),
      }));
      if (!updated)
        throw new VcsError({ code: "unavailable", message: `Unknown project: ${projectId}` });
      return updated;
    }
    return project;
  }
  async getProjectSelection(
    projectId: string,
  ): Promise<{ projectId: string; providerId: string | null }> {
    return this.serial(projectId, async () => {
      const project = await this.selected(projectId);
      return { projectId, providerId: project.vcsProviderId ?? null };
    });
  }
  private async bind(
    workspace: PersistedWorkspaceRecord,
    project: PersistedProjectRecord & { vcsProviderId: string },
  ): Promise<VcsBinding> {
    const providerId = project.vcsProviderId;
    const detection = await this.detect(providerId, workspace.cwd);
    if (detection.status === "unavailable") throw new VcsError(detection.error);
    if (detection.status === "absent")
      throw new VcsError({
        code: "unavailable",
        message: `Workspace is not a ${providerId} repository`,
      });
    const binding = detection.binding;
    const saved = workspace.vcsBinding;
    if (
      workspace.vcsBindingRevision === project.vcsSelectionRevision &&
      saved?.providerId === providerId &&
      (saved.repositoryId !== binding.repositoryId ||
        saved.workingCopyId !== binding.workingCopyId ||
        saved.root !== binding.root)
    )
      throw new VcsError({
        code: "outdated",
        message: "Working copy identity changed; select the project VCS again to rebind it",
      });
    if (
      workspace.vcsBindingRevision !== project.vcsSelectionRevision ||
      JSON.stringify(saved) !== JSON.stringify(binding)
    )
      await this.deps.workspaces.update(workspace.workspaceId, (current) => ({
        ...current,
        vcsBinding: binding,
        vcsBindingRevision: project.vcsSelectionRevision,
      }));
    return binding;
  }
  /** Provisioning remains available when a VCS executable is missing or the plugin is not ready. */
  async persistWorkspace(
    workspace: PersistedWorkspaceRecord,
    context?: WorkspaceMutationContext,
  ): Promise<PersistedWorkspaceRecord> {
    return this.lifecycle(() =>
      this.serial(workspace.projectId, async () => {
        let next = workspace;
        const project = await this.selected(workspace.projectId);
        if (project.archivedAt)
          throw new VcsError({
            code: "unavailable",
            message: "Cannot create a workspace in an archived project",
          });
        if (project.vcsProviderId) {
          const detection = await this.detect(project.vcsProviderId, workspace.cwd);
          if (detection.status === "available")
            next = {
              ...workspace,
              vcsBinding: detection.binding,
              vcsBindingRevision: project.vcsSelectionRevision,
            };
        }
        const owner = (await this.deps.workspaces.list()).find(
          (entry) =>
            entry.vcsWorkingCopy?.owned && references(entry.vcsWorkingCopy.binding.root, next),
        );
        if (
          owner?.vcsWorkingCopy &&
          (owner.vcsWorkingCopy.state === "restoring" || !(await pathExists(next.cwd)))
        )
          throw new VcsError({
            code: "unavailable",
            message: "Working copy is missing or its restore is incomplete",
          });
        if (owner?.vcsWorkingCopy)
          next = {
            ...next,
            vcsWorkingCopy: {
              ...owner.vcsWorkingCopy,
              binding: { ...owner.vcsWorkingCopy.binding, cwd: next.cwd },
            },
          };
        await this.deps.workspaces.upsert(next, context);
        return next;
      }),
    );
  }
  async selectProjectProvider(
    projectId: string,
    providerId: string,
  ): Promise<{ projectId: string; providerId: string }> {
    return this.lifecycle(() =>
      this.serial(projectId, async () => {
        const project = await this.project(projectId);
        if (project.archivedAt)
          throw new VcsError({
            code: "unavailable",
            message: "Restore the project before changing its VCS",
          });
        if (this.pendingRestores.has(projectId))
          throw new VcsError({
            code: "outdated",
            message: "Wait for working-copy recovery before switching providers",
          });
        await this.assertNoPendingOperations(projectId);
        const active = (await this.deps.workspaces.list()).filter(
          (workspace) => workspace.projectId === projectId && !workspace.archivedAt,
        );
        // Validate all targets before changing the single durable authority. Bindings are derived caches.
        for (const cwd of new Set([
          project.rootPath,
          ...active.map((workspace) => workspace.cwd),
        ])) {
          const result = await this.detect(providerId, cwd);
          if (result.status === "unavailable") throw new VcsError(result.error);
          if (result.status === "absent")
            throw new VcsError({
              code: "unavailable",
              message: `${providerId} does not recognize ${cwd}`,
            });
        }
        const updated = await this.deps.projects.update(projectId, (current) => {
          if (current.archivedAt)
            throw new VcsError({
              code: "unavailable",
              message: "Project was archived during VCS selection",
            });
          return {
            ...current,
            vcsProviderId: providerId,
            vcsSelectionRevision: randomUUID(),
            updatedAt: new Date().toISOString(),
          };
        });
        if (!updated) throw new Error("Project disappeared during VCS selection");
        // The project revision atomically invalidates binding caches, including after a restart.
        return { projectId, providerId };
      }),
    );
  }
  async withProjectBinding<T>(
    projectId: string,
    cwd: string,
    operation: (project: PersistedProjectRecord, binding: VcsBinding) => Promise<T>,
  ): Promise<T> {
    return this.lifecycle(() =>
      this.serial(projectId, async () => {
        const project = await this.selected(projectId);
        if (project.archivedAt || !project.vcsProviderId)
          throw new VcsError({ code: "unavailable", message: "Project VCS is unavailable" });
        const detection = await this.detect(project.vcsProviderId, cwd);
        if (detection.status === "unavailable") throw new VcsError(detection.error);
        if (detection.status !== "available")
          throw new VcsError({
            code: "unavailable",
            message: "Source is not a working copy of the selected VCS",
          });
        const root = await this.detect(project.vcsProviderId, project.rootPath);
        if (
          root.status !== "available" ||
          root.binding.repositoryId !== detection.binding.repositoryId
        )
          throw new VcsError({
            code: "outdated",
            message: "Source does not belong to this project repository",
          });
        return operation(project, detection.binding);
      }),
    );
  }
  async withWorkspace<T>(
    workspaceId: string,
    requestedProviderId: string | undefined,
    operation: (input: {
      workspace: PersistedWorkspaceRecord;
      providerId: string;
      binding: VcsBinding;
    }) => Promise<T>,
  ): Promise<T> {
    const workspace = await this.deps.workspaces.get(workspaceId);
    if (!workspace)
      throw new VcsError({ code: "unavailable", message: `Unknown workspace: ${workspaceId}` });
    return this.serial(workspace.projectId, async () => {
      const current = await this.deps.workspaces.get(workspaceId);
      if (!current)
        throw new VcsError({ code: "unavailable", message: `Unknown workspace: ${workspaceId}` });
      const project = await this.selected(current.projectId);
      const providerId = project.vcsProviderId;
      if (!providerId)
        throw new VcsError({
          code: "unavailable",
          message: "No VCS provider recognizes this project",
        });
      if (requestedProviderId && requestedProviderId !== providerId)
        throw new VcsError({
          code: "outdated",
          message: `Project uses ${providerId}; select another provider in project settings before using it`,
        });
      const binding = await this.bind(current, { ...project, vcsProviderId: providerId });
      return operation({ workspace: current, providerId, binding });
    });
  }
}
