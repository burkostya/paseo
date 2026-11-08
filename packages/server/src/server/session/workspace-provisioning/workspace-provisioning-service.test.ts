import os from "node:os";
import path from "node:path";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync } from "node:fs";

import { afterEach, beforeEach, expect, test } from "vitest";

import { getCheckoutStatus } from "../../../utils/checkout-git.js";
import { createTestLogger } from "../../../test-utils/test-logger.js";
import {
  createNoGitWorkspaceRuntimeSnapshot,
  createNoopWorkspaceGitService,
} from "../../test-utils/workspace-git-service-stub.js";
import {
  FileBackedProjectRegistry,
  FileBackedWorkspaceRegistry,
  type PersistedProjectRecord,
  createPersistedWorkspaceRecord,
  type WorkspaceRegistry,
} from "../../workspace-registry.js";
import { checkoutLiteFromGitSnapshot } from "../../workspace-registry-model.js";
import type { CreatePaseoWorktreeWorkflowResult } from "../../worktree-session.js";
import {
  createWorkspaceProvisioningService,
  WorkspaceProvisioningError,
  type WorkspaceProvisioningService,
} from "./workspace-provisioning-service.js";

// Real file-backed registries + a fake git-service port (the only dependency that
// shells out to git in production). No module mocks — the service is exercised
// through the same interface its callers in session.ts use.

const logger = createTestLogger();
const ARCHIVED_AT = "2026-01-01T00:00:00.000Z";
const directorySymlinkType = process.platform === "win32" ? "junction" : "dir";

// The real filesystem, so "this directory is gone" is observed rather than modelled.
async function isDirectory(target: string): Promise<boolean> {
  try {
    return statSync(target).isDirectory();
  } catch {
    return false;
  }
}

let tmpDir: string;
let gitRoots: Set<string>;
let gitBranches: Map<string, string | null>;
let checkoutFailure: Error | null;
let restoredMergedChangeRequestUrl: string | null;
let workspaceRegistry: FileBackedWorkspaceRegistry;
let projectRegistry: FileBackedProjectRegistry;
let provisioning: WorkspaceProvisioningService;

function gitService() {
  return createNoopWorkspaceGitService({
    getSnapshot: async (cwd: string) => {
      const snapshot = createNoGitWorkspaceRuntimeSnapshot(cwd);
      if (!restoredMergedChangeRequestUrl) return snapshot;
      return {
        ...snapshot,
        forge: {
          ...snapshot.forge,
          featuresEnabled: true,
          pullRequest: {
            url: restoredMergedChangeRequestUrl,
            title: "Merged change request",
            state: "merged",
            baseRefName: "main",
            headRefName: "workspace-archive-latch",
            isMerged: true,
          },
        },
      };
    },
    getCheckout: async (cwd: string) => {
      if (checkoutFailure) throw checkoutFailure;
      let worktreeRoot: string | null = null;
      for (const root of gitRoots) {
        if (
          (cwd === root || cwd.startsWith(`${root}${path.sep}`)) &&
          root.length > (worktreeRoot?.length ?? -1)
        ) {
          worktreeRoot = root;
        }
      }
      return {
        cwd,
        isGit: worktreeRoot !== null,
        currentBranch: worktreeRoot ? (gitBranches.get(worktreeRoot) ?? "main") : null,
        remoteUrl: null,
        worktreeRoot,
        isPaseoOwnedWorktree: false,
        mainRepoRoot: null,
      };
    },
  });
}

beforeEach(async () => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "workspace-provisioning-"));
  gitRoots = new Set();
  gitBranches = new Map();
  checkoutFailure = null;
  restoredMergedChangeRequestUrl = null;
  workspaceRegistry = new FileBackedWorkspaceRegistry(
    path.join(tmpDir, "projects", "workspaces.json"),
    logger,
  );
  projectRegistry = new FileBackedProjectRegistry(
    path.join(tmpDir, "projects", "projects.json"),
    logger,
  );
  await workspaceRegistry.initialize();
  await projectRegistry.initialize();
  provisioning = createWorkspaceProvisioningService({
    workspaceRegistry,
    projectRegistry,
    workspaceGitService: gitService(),
    isDirectory,
    logger,
  });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

test("fresh git repo creates a workspace at the canonical worktree root", async () => {
  const repo = path.join(tmpDir, "repo");
  gitRoots.add(repo);

  const workspace = await provisioning.findOrCreateWorkspaceForDirectory(repo);

  expect(workspace.cwd).toBe(repo);
  expect(await workspaceRegistry.list()).toHaveLength(1);
  expect(await projectRegistry.list()).toHaveLength(1);
});

test("fresh non-git directory creates a directory workspace at the exact path", async () => {
  const dir = path.join(tmpDir, "plain");

  const workspace = await provisioning.findOrCreateWorkspaceForDirectory(dir);

  expect(workspace.cwd).toBe(dir);
});

test("background workspace creation preserves hooks, inheritance and durable visibility", async () => {
  const dir = path.join(tmpDir, "plain");
  const events: string[] = [];
  provisioning = createWorkspaceProvisioningService({
    workspaceRegistry,
    projectRegistry,
    workspaceGitService: gitService(),
    isDirectory,
    logger,
    lifecycle: {
      emit: (name) => {
        events.push(name);
      },
      before: async (_name, request) => request,
    },
  });
  const parent = await provisioning.createWorkspaceForDirectory(dir, null, undefined, {
    background: true,
  });
  const child = await provisioning.createWorkspaceForDirectory(dir, null, undefined, {
    callerWorkspaceId: parent.workspaceId,
  });
  const visible = await provisioning.createWorkspaceForDirectory(dir, null, undefined, {
    callerWorkspaceId: parent.workspaceId,
    background: false,
  });
  const human = await provisioning.createWorkspaceForDirectory(dir);
  expect(parent.background).toBe(true);
  expect(child.background).toBe(true);
  expect(visible.background).toBe(false);
  expect(human.background).toBe(false);
  expect(events).toEqual(Array(4).fill("workspace.create.after"));
  const reloaded = new FileBackedWorkspaceRegistry(
    path.join(tmpDir, "projects", "workspaces.json"),
    logger,
  );
  await reloaded.initialize();
  expect((await reloaded.get(child.workspaceId))?.background).toBe(true);
});

test("re-opening an active workspace by exact path returns the same record without duplicating", async () => {
  const repo = path.join(tmpDir, "repo");
  gitRoots.add(repo);

  const first = await provisioning.findOrCreateWorkspaceForDirectory(repo);
  const second = await provisioning.findOrCreateWorkspaceForDirectory(repo);

  expect(second.workspaceId).toBe(first.workspaceId);
  expect(await workspaceRegistry.list()).toHaveLength(1);
});

test("re-opening Windows-equivalent workspace cwd spellings reuses the active and archived record", async () => {
  const cwd = path.join(tmpDir, "workspace");
  const created = await provisioning.findOrCreateWorkspaceForDirectory(cwd);
  await workspaceRegistry.upsert({ ...created, cwd: `${cwd}${path.sep}` });

  const active = await provisioning.findOrCreateWorkspaceForDirectory(cwd);
  expect(active.workspaceId).toBe(created.workspaceId);
  expect(await workspaceRegistry.list()).toHaveLength(1);

  await workspaceRegistry.archive(created.workspaceId, ARCHIVED_AT);
  const reopened = await provisioning.findOrCreateWorkspaceForDirectory(cwd);
  expect(reopened).toMatchObject({ workspaceId: created.workspaceId, archivedAt: null });
  expect(await workspaceRegistry.list()).toHaveLength(1);
});

test("re-opening refreshes mutable checkout metadata without renaming the workspace", async () => {
  const repo = path.join(tmpDir, "repo");
  mkdirSync(repo, { recursive: true });
  const first = await provisioning.findOrCreateWorkspaceForDirectory(repo);
  await workspaceRegistry.upsert({ ...first, title: "Pinned work" });
  gitRoots.add(repo);
  gitBranches.set(repo, "feature/refresh");

  const refreshed = await provisioning.findOrCreateWorkspaceForDirectory(repo);

  expect(refreshed).toMatchObject({
    workspaceId: first.workspaceId,
    kind: "local_checkout",
    branch: "feature/refresh",
    displayName: first.displayName,
    title: "Pinned work",
    isPaseoOwnedWorktree: false,
    mainRepoRoot: null,
  });
  expect(await workspaceRegistry.get(first.workspaceId)).toEqual(refreshed);
  expect((await projectRegistry.get(first.projectId))?.kind).toBe("git");
});

test("persists manual worktree ownership separately from its workspace kind", async () => {
  const cwd = path.join(tmpDir, "manual-worktree");
  const mainRepoRoot = path.join(tmpDir, "main-repo");
  const manualWorktreeProvisioning = createWorkspaceProvisioningService({
    workspaceRegistry,
    projectRegistry,
    isDirectory,
    workspaceGitService: createNoopWorkspaceGitService({
      getCheckout: async () => ({
        cwd,
        isGit: true,
        currentBranch: "feature/manual",
        remoteUrl: null,
        worktreeRoot: cwd,
        isPaseoOwnedWorktree: false,
        mainRepoRoot,
      }),
    }),
  });

  const workspace = await manualWorktreeProvisioning.findOrCreateWorkspaceForDirectory(cwd);

  expect(workspace).toMatchObject({
    kind: "worktree",
    isPaseoOwnedWorktree: false,
    mainRepoRoot,
  });
});

test("re-opening an archived workspace by its exact path unarchives it and keeps the id", async () => {
  const repo = path.join(tmpDir, "repo");
  gitRoots.add(repo);
  const created = await provisioning.findOrCreateWorkspaceForDirectory(repo);
  await workspaceRegistry.archive(created.workspaceId, ARCHIVED_AT);

  const reopened = await provisioning.findOrCreateWorkspaceForDirectory(repo);

  expect(reopened.workspaceId).toBe(created.workspaceId);
  expect(reopened.archivedAt).toBeNull();
});

test("default directory open skips archived background workspaces while explicit recovery preserves their visibility", async () => {
  const cwd = path.join(tmpDir, "repo");
  mkdirSync(cwd, { recursive: true });
  const background = await provisioning.createWorkspaceForDirectory(cwd, undefined, undefined, {
    background: true,
  });
  await workspaceRegistry.archive(background.workspaceId, ARCHIVED_AT);

  const opened = await provisioning.findOrCreateWorkspaceForDirectory(cwd);
  expect(opened).toMatchObject({ background: false, archivedAt: null });
  expect(opened.workspaceId).not.toBe(background.workspaceId);
  const archived = await workspaceRegistry.get(background.workspaceId);
  expect(archived).toMatchObject({ background: true, archivedAt: ARCHIVED_AT });
  const recovered = await provisioning.ensureWorkspaceRecordUnarchived(archived!);
  expect(recovered).toMatchObject({
    workspaceId: background.workspaceId,
    background: true,
    archivedAt: null,
  });
  expect((await provisioning.findOrCreateWorkspaceForDirectory(cwd)).workspaceId).toBe(
    opened.workspaceId,
  );
});

test("reopening archived exact-root records restores the fresh Git project", async () => {
  const cwd = path.join(tmpDir, "repo");
  mkdirSync(cwd, { recursive: true });
  const project = await projectRegistry.getOrCreateActiveByRoot({
    rootPath: cwd,
    kind: "non_git",
    displayName: "repo",
    timestamp: ARCHIVED_AT,
  });
  await projectRegistry.upsert({
    ...project,
    projectKey: "remote:github.com/acme/old-repo",
  });
  const workspace = createPersistedWorkspaceRecord({
    workspaceId: "ws-archived-root",
    projectId: project.projectId,
    cwd,
    kind: "directory",
    displayName: "repo",
    createdAt: ARCHIVED_AT,
    updatedAt: ARCHIVED_AT,
    archivedAt: ARCHIVED_AT,
  });
  await workspaceRegistry.upsert(workspace);
  await projectRegistry.archive(project.projectId, ARCHIVED_AT);
  const archivedProvisioning = createWorkspaceProvisioningService({
    workspaceRegistry,
    projectRegistry,
    isDirectory,
    workspaceGitService: createNoopWorkspaceGitService({
      getCheckout: async () => ({
        cwd,
        isGit: true,
        currentBranch: "main",
        remoteUrl: "https://github.com/acme/new-repo.git",
        worktreeRoot: cwd,
        isPaseoOwnedWorktree: false,
        mainRepoRoot: null,
      }),
    }),
  });

  const reopened = await archivedProvisioning.ensureWorkspaceRecordUnarchived(workspace);

  expect(reopened).toMatchObject({
    workspaceId: workspace.workspaceId,
    kind: "local_checkout",
    archivedAt: null,
  });
  expect(await projectRegistry.get(project.projectId)).toMatchObject({
    kind: "git",
    projectKey: "remote:github.com/acme/new-repo",
    archivedAt: null,
  });
});

test("uses one workspace snapshot when reopening an archived workspace", async () => {
  const repo = path.join(tmpDir, "repo");
  mkdirSync(repo, { recursive: true });
  gitRoots.add(repo);
  const created = await provisioning.findOrCreateWorkspaceForDirectory(repo);
  await workspaceRegistry.archive(created.workspaceId, ARCHIVED_AT);

  const archived = (await workspaceRegistry.list()).filter(
    (workspace) => workspace.workspaceId === created.workspaceId,
  );
  let reads = 0;
  const snapshotRegistry: WorkspaceRegistry = {
    initialize: () => workspaceRegistry.initialize(),
    existsOnDisk: () => workspaceRegistry.existsOnDisk(),
    list: async () => (reads++ === 0 ? archived : []),
    get: (workspaceId) => workspaceRegistry.get(workspaceId),
    upsert: (workspace) => workspaceRegistry.upsert(workspace),
    archive: (workspaceId, archivedAt) => workspaceRegistry.archive(workspaceId, archivedAt),
    remove: (workspaceId) => workspaceRegistry.remove(workspaceId),
  };
  const snapshotProvisioning = createWorkspaceProvisioningService({
    workspaceRegistry: snapshotRegistry,
    projectRegistry,
    workspaceGitService: gitService(),
    isDirectory,
  });

  const reopened = await snapshotProvisioning.findOrCreateWorkspaceForDirectory(repo);

  expect(reopened).toMatchObject({ workspaceId: created.workspaceId, archivedAt: null });
  expect(await workspaceRegistry.list()).toHaveLength(1);
});

test("reopening an archived workspace refreshes placement without renaming it", async () => {
  const repo = path.join(tmpDir, "repo");
  mkdirSync(repo, { recursive: true });
  gitRoots.add(repo);
  const created = await provisioning.findOrCreateWorkspaceForDirectory(repo);
  await workspaceRegistry.upsert({ ...created, title: "Pinned archived work" });
  await workspaceRegistry.archive(created.workspaceId, ARCHIVED_AT);
  gitRoots.delete(repo);

  const reopened = await provisioning.findOrCreateWorkspaceForDirectory(repo);

  expect(reopened).toMatchObject({
    workspaceId: created.workspaceId,
    projectId: created.projectId,
    title: "Pinned archived work",
    kind: "directory",
    branch: null,
    displayName: created.displayName,
    archivedAt: null,
  });
  expect(reopened.updatedAt).toEqual(expect.any(String));
  expect(await workspaceRegistry.get(created.workspaceId)).toEqual(reopened);
});

test("opening a subpath of an archived git workspace mints a fresh workspace at the exact subpath", async () => {
  const repo = path.join(tmpDir, "repo");
  gitRoots.add(repo);
  const canonical = await provisioning.findOrCreateWorkspaceForDirectory(repo);
  await workspaceRegistry.archive(canonical.workspaceId, ARCHIVED_AT);
  const sub = path.join(repo, "packages", "app");

  const fresh = await provisioning.findOrCreateWorkspaceForDirectory(sub);

  expect(fresh.cwd).toBe(sub);
  expect(fresh.workspaceId).not.toBe(canonical.workspaceId);
  expect((await workspaceRegistry.get(canonical.workspaceId))?.archivedAt).toBe(ARCHIVED_AT);
});

test("ensureWorkspaceRecordUnarchived restores the owning archived project with the workspace", async () => {
  const repo = path.join(tmpDir, "repo");
  gitRoots.add(repo);
  const created = await provisioning.findOrCreateWorkspaceForDirectory(repo);
  await projectRegistry.archive(created.projectId, ARCHIVED_AT);

  const unarchived = await provisioning.ensureWorkspaceRecordUnarchived({
    ...created,
    archivedAt: ARCHIVED_AT,
  });

  expect(unarchived.archivedAt).toBeNull();
  expect((await workspaceRegistry.get(created.workspaceId))?.archivedAt).toBeNull();
  expect((await projectRegistry.get(created.projectId))?.archivedAt).toBeNull();
});

test("ensureWorkspaceRecordUnarchived preserves the consumed auto-archive change request", async () => {
  const repo = path.join(tmpDir, "repo");
  const changeRequestUrl = "https://github.com/getpaseo/paseo/pull/2714";
  gitRoots.add(repo);
  const created = await provisioning.findOrCreateWorkspaceForDirectory(repo);
  await workspaceRegistry.archive(created.workspaceId, ARCHIVED_AT, {
    autoArchivedChangeRequestUrl: changeRequestUrl,
  });
  const archivedWorkspace = await workspaceRegistry.get(created.workspaceId);

  const unarchived = await provisioning.ensureWorkspaceRecordUnarchived(archivedWorkspace!);

  expect(unarchived).toMatchObject({
    archivedAt: null,
    autoArchivedChangeRequestUrl: changeRequestUrl,
  });
  expect(await workspaceRegistry.get(created.workspaceId)).toMatchObject({
    archivedAt: null,
    autoArchivedChangeRequestUrl: changeRequestUrl,
  });
});

test("ensureWorkspaceRecordUnarchived acknowledges a merged change request for a legacy archive", async () => {
  const repo = path.join(tmpDir, "repo");
  const changeRequestUrl = "https://github.com/getpaseo/paseo/pull/2714";
  gitRoots.add(repo);
  const created = await provisioning.findOrCreateWorkspaceForDirectory(repo);
  await workspaceRegistry.archive(created.workspaceId, ARCHIVED_AT);
  const archivedWorkspace = await workspaceRegistry.get(created.workspaceId);
  restoredMergedChangeRequestUrl = changeRequestUrl;

  const unarchived = await provisioning.ensureWorkspaceRecordUnarchived(archivedWorkspace!);

  expect(unarchived).toMatchObject({
    archivedAt: null,
    autoArchivedChangeRequestUrl: changeRequestUrl,
  });
  expect(await workspaceRegistry.get(created.workspaceId)).toMatchObject({
    archivedAt: null,
    autoArchivedChangeRequestUrl: changeRequestUrl,
  });
});

test("ensureWorkspaceRecordUnarchived refreshes the latch for a different merged change request", async () => {
  const repo = path.join(tmpDir, "repo");
  const previousChangeRequestUrl = "https://github.com/getpaseo/paseo/pull/2713";
  const currentChangeRequestUrl = "https://github.com/getpaseo/paseo/pull/2714";
  gitRoots.add(repo);
  const created = await provisioning.findOrCreateWorkspaceForDirectory(repo);
  await workspaceRegistry.archive(created.workspaceId, ARCHIVED_AT, {
    autoArchivedChangeRequestUrl: previousChangeRequestUrl,
  });
  const archivedWorkspace = await workspaceRegistry.get(created.workspaceId);
  restoredMergedChangeRequestUrl = currentChangeRequestUrl;

  const unarchived = await provisioning.ensureWorkspaceRecordUnarchived(archivedWorkspace!);

  expect(unarchived).toMatchObject({
    archivedAt: null,
    autoArchivedChangeRequestUrl: currentChangeRequestUrl,
  });
  expect(await workspaceRegistry.get(created.workspaceId)).toMatchObject({
    archivedAt: null,
    autoArchivedChangeRequestUrl: currentChangeRequestUrl,
  });
});

test("does not unarchive either record when checkout refresh fails", async () => {
  const repo = path.join(tmpDir, "repo");
  mkdirSync(repo, { recursive: true });
  gitRoots.add(repo);
  const created = await provisioning.findOrCreateWorkspaceForDirectory(repo);
  await projectRegistry.archive(created.projectId, ARCHIVED_AT);
  await workspaceRegistry.archive(created.workspaceId, ARCHIVED_AT);
  const archivedProject = await projectRegistry.get(created.projectId);
  const archivedWorkspace = await workspaceRegistry.get(created.workspaceId);
  checkoutFailure = new Error("Git read failed");

  await expect(provisioning.ensureWorkspaceRecordUnarchived(archivedWorkspace!)).rejects.toThrow(
    "Git read failed",
  );

  expect(await projectRegistry.get(created.projectId)).toEqual(archivedProject);
  expect(await workspaceRegistry.get(created.workspaceId)).toEqual(archivedWorkspace);
});

test("resolveOrCreateWorkspaceIdForCreateAgent returns a created worktree's id without touching the registry", async () => {
  // The branch only reads workspace.workspaceId off the worktree result.
  const createdWorktree = {
    workspace: { workspaceId: "ws-from-worktree" },
  } as unknown as CreatePaseoWorktreeWorkflowResult;

  const id = await provisioning.resolveOrCreateWorkspaceIdForCreateAgent({
    createdWorktree,
    cwd: path.join(tmpDir, "x"),
    initialTitle: null,
  });

  expect(id).toBe("ws-from-worktree");
  expect(await workspaceRegistry.list()).toHaveLength(0);
});

test("resolveOrCreateWorkspaceIdForCreateAgent honors an explicitly requested workspace id", async () => {
  const id = await provisioning.resolveOrCreateWorkspaceIdForCreateAgent({
    createdWorktree: null,
    requestedWorkspaceId: "ws-requested",
    cwd: path.join(tmpDir, "x"),
    initialTitle: null,
  });

  expect(id).toBe("ws-requested");
  expect(await workspaceRegistry.list()).toHaveLength(0);
});

test("resolveOrCreateWorkspaceIdForCreateAgent creates a titled workspace when nothing is provided", async () => {
  const dir = path.join(tmpDir, "plain");

  const id = await provisioning.resolveOrCreateWorkspaceIdForCreateAgent({
    createdWorktree: null,
    cwd: dir,
    initialTitle: "My Title",
  });

  const created = await workspaceRegistry.get(id);
  expect(created?.cwd).toBe(dir);
  expect(created?.title).toBe("My Title");
});

test("createWorkspaceForDirectory always mints a fresh workspace even when one already occupies the cwd", async () => {
  const repo = path.join(tmpDir, "repo");
  gitRoots.add(repo);

  const first = await provisioning.createWorkspaceForDirectory(repo);
  const second = await provisioning.createWorkspaceForDirectory(repo);

  expect(second.workspaceId).not.toBe(first.workspaceId);
  expect(await workspaceRegistry.list()).toHaveLength(2);
});

test("directory creation persists the live branch and a trimmed title", async () => {
  const repo = path.join(tmpDir, "repo");
  gitRoots.add(repo);
  const workspace = await provisioning.createWorkspaceForDirectory(repo, "  Focused work  ");
  expect(workspace).toMatchObject({ branch: "main", title: "Focused work" });
});

test("createWorkspaceForDirectory honors an explicit active project without cwd containment", async () => {
  const project = await projectRegistry.getOrCreateActiveByRoot({
    rootPath: path.join(tmpDir, "elsewhere"),
    kind: "non_git",
    displayName: "elsewhere",
    timestamp: "2026-03-01T00:00:00.000Z",
  });
  const workspace = await provisioning.createWorkspaceForDirectory(
    path.join(tmpDir, "directory"),
    null,
    project.projectId,
  );
  expect(workspace.projectId).toBe(project.projectId);
});

test("createWorkspaceForDirectory refreshes an explicit project's stale Git kind", async () => {
  const rootPath = path.join(tmpDir, "repo");
  gitRoots.add(rootPath);
  const project = await projectRegistry.getOrCreateActiveByRoot({
    rootPath,
    kind: "non_git",
    displayName: "Saved project name",
    timestamp: ARCHIVED_AT,
  });
  await projectRegistry.upsert({ ...project, customName: "Pinned project name" });

  const workspace = await provisioning.createWorkspaceForDirectory(
    rootPath,
    null,
    project.projectId,
  );

  expect(workspace.projectId).toBe(project.projectId);
  expect(await projectRegistry.get(project.projectId)).toMatchObject({
    projectId: project.projectId,
    rootPath,
    kind: "git",
    displayName: "Saved project name",
    customName: "Pinned project name",
  });
});

test("createWorkspaceForDirectory classifies unknown and archived explicit projects", async () => {
  await expect(
    provisioning.createWorkspaceForDirectory(path.join(tmpDir, "directory"), null, "missing"),
  ).rejects.toMatchObject({
    code: "unknown_project",
  } satisfies Partial<WorkspaceProvisioningError>);
  const project = await projectRegistry.getOrCreateActiveByRoot({
    rootPath: path.join(tmpDir, "archived"),
    kind: "non_git",
    displayName: "archived",
    timestamp: "2026-03-01T00:00:00.000Z",
  });
  await projectRegistry.archive(project.projectId, "2026-03-02T00:00:00.000Z");
  await expect(
    provisioning.createWorkspaceForDirectory(
      path.join(tmpDir, "directory"),
      null,
      project.projectId,
    ),
  ).rejects.toMatchObject({
    code: "archived_project",
  } satisfies Partial<WorkspaceProvisioningError>);
});

test("findOrCreateProjectForDirectory keeps nested selected roots independent", async () => {
  const repo = path.join(tmpDir, "repo");
  gitRoots.add(repo);

  const first = await provisioning.findOrCreateProjectForDirectory(repo);
  const second = await provisioning.findOrCreateProjectForDirectory(path.join(repo, "sub"));

  expect(second.projectId).not.toBe(first.projectId);
  expect(first.rootPath).toBe(repo);
  expect(second.rootPath).toBe(path.join(repo, "sub"));
  expect(await projectRegistry.list()).toHaveLength(2);
});

test("runInImportWorkspace uses an active requested workspace without creating another", async () => {
  const cwd = path.join(tmpDir, "requested");
  mkdirSync(cwd);
  const workspace = await provisioning.createWorkspaceForDirectory(cwd);

  const result = await provisioning.runInImportWorkspace(
    { cwd, requestedWorkspaceId: workspace.workspaceId },
    async (target) => target.workspaceId,
  );

  expect(result).toEqual({ value: workspace.workspaceId, createdWorkspace: null });
  expect(await workspaceRegistry.list()).toEqual([workspace]);
});

test("runInImportWorkspace reuses an active workspace for an untargeted import", async () => {
  const cwd = path.join(tmpDir, "active-import");
  mkdirSync(cwd);
  const workspace = await provisioning.createWorkspaceForDirectory(cwd);

  const result = await provisioning.runInImportWorkspace(
    { cwd },
    async (target) => target.workspaceId,
  );

  expect(result).toEqual({ value: workspace.workspaceId, createdWorkspace: null });
  expect(await workspaceRegistry.list()).toEqual([workspace]);
});

test("runInImportWorkspace unarchives a workspace for an untargeted import", async () => {
  const cwd = path.join(tmpDir, "archived-import");
  mkdirSync(cwd);
  const workspace = await provisioning.createWorkspaceForDirectory(cwd);
  await workspaceRegistry.archive(workspace.workspaceId, ARCHIVED_AT);

  const result = await provisioning.runInImportWorkspace(
    { cwd },
    async (target) => target.workspaceId,
  );

  expect(result).toEqual({ value: workspace.workspaceId, createdWorkspace: null });
  expect(await workspaceRegistry.get(workspace.workspaceId)).toMatchObject({
    workspaceId: workspace.workspaceId,
    archivedAt: null,
  });
  expect(await workspaceRegistry.list()).toHaveLength(1);
});

test("runInImportWorkspace leaves a reused workspace intact when import fails", async () => {
  const cwd = path.join(tmpDir, "failed-active-import");
  mkdirSync(cwd);
  const workspace = await provisioning.createWorkspaceForDirectory(cwd);
  const project = await projectRegistry.get(workspace.projectId);

  await expect(
    provisioning.runInImportWorkspace({ cwd }, async () => {
      throw new Error("provider session is unavailable");
    }),
  ).rejects.toThrow("provider session is unavailable");

  expect(await workspaceRegistry.list()).toEqual([workspace]);
  expect(await projectRegistry.get(workspace.projectId)).toEqual(project);
});

test.each(["missing", "archived"] as const)(
  "runInImportWorkspace rejects a %s requested workspace before importing",
  async (state) => {
    const cwd = path.join(tmpDir, "unavailable-workspace");
    mkdirSync(cwd);
    const workspace = await provisioning.createWorkspaceForDirectory(cwd);
    if (state === "archived") {
      await workspaceRegistry.archive(workspace.workspaceId, ARCHIVED_AT);
    } else {
      await workspaceRegistry.remove(workspace.workspaceId);
    }
    let imported = false;

    await expect(
      provisioning.runInImportWorkspace(
        { cwd, requestedWorkspaceId: workspace.workspaceId },
        async () => {
          imported = true;
        },
      ),
    ).rejects.toThrow(`Workspace not found: ${workspace.workspaceId}`);
    expect(imported).toBe(false);
  },
);

test.each(["missing", "archived"] as const)(
  "runInImportWorkspace rejects a requested workspace whose project is %s before importing",
  async (state) => {
    const cwd = path.join(tmpDir, "unavailable-project");
    mkdirSync(cwd);
    const workspace = await provisioning.createWorkspaceForDirectory(cwd);
    if (state === "archived") {
      await projectRegistry.archive(workspace.projectId, ARCHIVED_AT);
    } else {
      await projectRegistry.remove(workspace.projectId);
    }
    let imported = false;

    await expect(
      provisioning.runInImportWorkspace(
        { cwd, requestedWorkspaceId: workspace.workspaceId },
        async () => {
          imported = true;
        },
      ),
    ).rejects.toThrow(`Project not found: ${workspace.projectId}`);
    expect(imported).toBe(false);
  },
);

test("runInImportWorkspace accepts a filesystem-equivalent requested cwd", async () => {
  const cwd = path.join(tmpDir, "real-directory");
  const alias = path.join(tmpDir, "directory-alias");
  mkdirSync(cwd);
  symlinkSync(cwd, alias, directorySymlinkType);
  const workspace = await provisioning.createWorkspaceForDirectory(cwd);

  const result = await provisioning.runInImportWorkspace(
    { cwd: alias, requestedWorkspaceId: workspace.workspaceId },
    async (target) => target.workspaceId,
  );

  expect(result.value).toBe(workspace.workspaceId);
});

test("runInImportWorkspace rejects a requested workspace with a different cwd", async () => {
  const cwd = path.join(tmpDir, "workspace-directory");
  const otherCwd = path.join(tmpDir, "other-directory");
  mkdirSync(cwd);
  mkdirSync(otherCwd);
  const workspace = await provisioning.createWorkspaceForDirectory(cwd);
  let imported = false;

  await expect(
    provisioning.runInImportWorkspace(
      { cwd: otherCwd, requestedWorkspaceId: workspace.workspaceId },
      async () => {
        imported = true;
      },
    ),
  ).rejects.toThrow(`Import cwd does not match workspace: ${workspace.workspaceId}`);
  expect(imported).toBe(false);
});

test("runInImportWorkspace creates one fresh workspace for an untargeted import", async () => {
  const cwd = path.join(tmpDir, "fresh-import");
  mkdirSync(cwd);

  const result = await provisioning.runInImportWorkspace(
    { cwd },
    async (workspace) => workspace.workspaceId,
  );

  expect(result.value).toBe(result.createdWorkspace?.workspaceId);
  expect(await workspaceRegistry.list()).toEqual([result.createdWorkspace]);
});

test.each(["missing", "archived"] as const)(
  "runInImportWorkspace restores the exact %s project state when an untargeted import fails",
  async (state) => {
    const cwd = path.join(tmpDir, `failed-import-${state}`);
    mkdirSync(cwd);
    let previousProject: PersistedProjectRecord | null = null;
    if (state === "archived") {
      const project = await provisioning.findOrCreateProjectForDirectory(cwd);
      await projectRegistry.archive(project.projectId, ARCHIVED_AT);
      previousProject = await projectRegistry.get(project.projectId);
    }

    await expect(
      provisioning.runInImportWorkspace({ cwd }, async () => {
        throw new Error("provider session is unavailable");
      }),
    ).rejects.toThrow("provider session is unavailable");

    expect(await workspaceRegistry.list()).toEqual([]);
    expect(await projectRegistry.list()).toEqual(previousProject ? [previousProject] : []);
  },
);

test("a failed import keeps an archived worktree's placement when its directory is gone", async () => {
  // The git port here is the production read: getCheckoutStatus against the real
  // filesystem, so "the worktree directory is gone" is observed, not modelled.
  const mainRepoRoot = path.join(tmpDir, "main-repo");
  mkdirSync(mainRepoRoot, { recursive: true });
  const worktreeCwd = path.join(tmpDir, "worktrees", "feature-example");
  const project = await projectRegistry.getOrCreateActiveByRoot({
    rootPath: mainRepoRoot,
    kind: "git",
    displayName: "main-repo",
    timestamp: ARCHIVED_AT,
  });
  const archived = createPersistedWorkspaceRecord({
    workspaceId: "ws-archived-worktree",
    projectId: project.projectId,
    cwd: worktreeCwd,
    kind: "worktree",
    displayName: "feature/example",
    branch: "feature/example",
    worktreeRoot: worktreeCwd,
    baseBranch: "main",
    isPaseoOwnedWorktree: true,
    mainRepoRoot,
    createdAt: ARCHIVED_AT,
    updatedAt: ARCHIVED_AT,
    archivedAt: ARCHIVED_AT,
  });
  await workspaceRegistry.upsert(archived);
  const realCheckoutProvisioning = createWorkspaceProvisioningService({
    workspaceRegistry,
    projectRegistry,
    logger,
    isDirectory,
    workspaceGitService: createNoopWorkspaceGitService({
      getCheckout: async (cwd: string) => {
        const status = await getCheckoutStatus(cwd, { logger });
        return checkoutLiteFromGitSnapshot(
          cwd,
          status.isGit
            ? {
                isGit: true,
                currentBranch: status.currentBranch,
                remoteUrl: status.remoteUrl,
                repoRoot: status.repoRoot,
                isPaseoOwnedWorktree: status.isPaseoOwnedWorktree,
                mainRepoRoot: status.mainRepoRoot,
              }
            : {
                isGit: false,
                currentBranch: null,
                remoteUrl: null,
                repoRoot: null,
                isPaseoOwnedWorktree: false,
                mainRepoRoot: null,
              },
        );
      },
    }),
  });

  await expect(
    realCheckoutProvisioning.runInImportWorkspace({ cwd: worktreeCwd }, async () => {
      throw new Error("provider resume failed");
    }),
  ).rejects.toThrow("provider resume failed");

  expect(await workspaceRegistry.get(archived.workspaceId)).toMatchObject({
    kind: "worktree",
    branch: "feature/example",
    worktreeRoot: worktreeCwd,
    mainRepoRoot,
    isPaseoOwnedWorktree: true,
  });
});

test("re-opening an active worktree workspace keeps its placement while the directory is away", async () => {
  const repo = path.join(tmpDir, "repo");
  mkdirSync(repo, { recursive: true });
  gitRoots.add(repo);
  gitBranches.set(repo, "feature/away");
  const created = await provisioning.findOrCreateWorkspaceForDirectory(repo);
  expect(created).toMatchObject({ kind: "local_checkout", branch: "feature/away" });
  rmSync(repo, { recursive: true, force: true });
  gitRoots.delete(repo);

  const reopened = await provisioning.findOrCreateWorkspaceForDirectory(repo);

  expect(reopened).toMatchObject({
    workspaceId: created.workspaceId,
    kind: "local_checkout",
    branch: "feature/away",
  });
});

test("a directory that goes away while the git read is in flight keeps its placement", async () => {
  const repo = path.join(tmpDir, "repo");
  mkdirSync(repo, { recursive: true });
  gitRoots.add(repo);
  gitBranches.set(repo, "feature/vanishing");
  const created = await provisioning.findOrCreateWorkspaceForDirectory(repo);
  expect(created).toMatchObject({ kind: "local_checkout", branch: "feature/vanishing" });
  const vanishingProvisioning = createWorkspaceProvisioningService({
    workspaceRegistry,
    projectRegistry,
    isDirectory,
    logger,
    workspaceGitService: createNoopWorkspaceGitService({
      getCheckout: async (cwd: string) => {
        rmSync(repo, { recursive: true, force: true });
        return {
          cwd,
          isGit: false,
          currentBranch: null,
          remoteUrl: null,
          worktreeRoot: null,
          isPaseoOwnedWorktree: false,
          mainRepoRoot: null,
        };
      },
    }),
  });

  const reopened = await vanishingProvisioning.findOrCreateWorkspaceForDirectory(repo);

  expect(reopened).toMatchObject({
    workspaceId: created.workspaceId,
    kind: "local_checkout",
    branch: "feature/vanishing",
  });
});

test("VCS provisioning selects jj for new colocated projects and validates project-wide switching", async () => {
  const { execCommand } = await import("@getpaseo/plugin/server");
  const { createVcsHandler } = await import("@getpaseo/plugin/server/vcs");
  const { jjProvider } = await import("../../../../../../plugins/jj-vcs/server/provider.js");
  const { gitProvider } = await import("../../../../../../plugins/git-vcs/server/provider.js");
  const { resolveWorkspaceVcsService } = await import("../../workspace-vcs-service.js");
  const cwd = path.join(tmpDir, "colocated");
  await execCommand("jj", ["git", "init", "--colocate", cwd]);
  gitRoots.add(cwd);
  const handlers = new Map([
    ["jj", createVcsHandler(jjProvider)],
    ["git", createVcsHandler(gitProvider)],
  ]);
  const plugins = {
    listVcsProviders: () => [
      { id: "jj", pluginId: "jj-vcs", label: "Jujutsu", detectionPriority: 10 },
      { id: "git", pluginId: "git-vcs", label: "Git" },
    ],
    invokeVcs: async (providerId: string, request: import("@getpaseo/protocol/vcs").VcsRequest) => {
      const handler = handlers.get(providerId);
      if (!handler) throw new Error("Missing provider");
      return handler.handle(request);
    },
  };
  const service = resolveWorkspaceVcsService({
    projects: projectRegistry,
    workspaces: workspaceRegistry,
    plugins,
  });
  provisioning = createWorkspaceProvisioningService({
    workspaceRegistry,
    projectRegistry,
    workspaceGitService: gitService(),
    isDirectory,
    logger,
    vcsPlugins: plugins,
  });
  try {
    const workspace = await provisioning.createWorkspaceForDirectory(cwd);
    expect((await projectRegistry.get(workspace.projectId))!.vcsProviderId).toBe("jj");
    expect(workspace.vcsBinding).toMatchObject({ providerId: "jj", cwd });
    const called: string[] = [];
    await expect(
      service.runLegacyGit(cwd, async () => {
        called.push("git");
      }),
    ).rejects.toThrow("use its VCS actions");
    expect(called).toEqual([]);
    await service.selectProjectProvider(workspace.projectId, "git");
    expect((await projectRegistry.get(workspace.projectId))!.vcsProviderId).toBe("git");
    await service.withWorkspace(
      workspace.workspaceId,
      undefined,
      async ({ providerId, binding }) => {
        expect(providerId).toBe("git");
        expect(binding.cwd).toBe(cwd);
      },
    );
    await service.runLegacyGit(cwd, async () => {
      called.push("git");
    });
    expect(called).toEqual(["git"]);
    const outside = path.join(tmpDir, "plain");
    mkdirSync(outside);
    await provisioning.createWorkspaceForDirectory(outside, null, workspace.projectId);
    await expect(service.selectProjectProvider(workspace.projectId, "jj")).rejects.toThrow(
      "does not recognize",
    );
    expect((await projectRegistry.get(workspace.projectId))!.vcsProviderId).toBe("git");
    const reopened = await provisioning.findOrCreateWorkspaceForDirectory(cwd);
    expect(reopened.workspaceId).toBe(workspace.workspaceId);
    expect(reopened.projectId).toBe(workspace.projectId);
  } finally {
    for (const handler of handlers.values()) handler.dispose();
  }
});

test("VCS unavailable provider retains ownership while directory provisioning stays available", async () => {
  const { resolveWorkspaceVcsService } = await import("../../workspace-vcs-service.js");
  const calls: string[] = [];
  const cwd = path.join(tmpDir, "unavailable");
  mkdirSync(cwd);
  const plugins = {
    listVcsProviders: () => [
      { id: "jj", pluginId: "jj-vcs", label: "Jujutsu", detectionPriority: 10 },
      { id: "git", pluginId: "git-vcs", label: "Git" },
    ],
    invokeVcs: async (
      providerId: string,
      request: import("@getpaseo/protocol/vcs").VcsRequest,
    ): Promise<import("@getpaseo/protocol/vcs").VcsResponse> => {
      calls.push(providerId);
      if (request.kind !== "detect") throw new Error("Unexpected read");
      return {
        kind: "detect",
        detection: {
          status: "unavailable",
          error: { code: "unsupported-version", message: "Install Jujutsu 0.46.0" },
        },
      };
    },
  };
  provisioning = createWorkspaceProvisioningService({
    workspaceRegistry,
    projectRegistry,
    workspaceGitService: gitService(),
    isDirectory,
    logger,
    vcsPlugins: plugins,
  });
  const workspace = await provisioning.createWorkspaceForDirectory(cwd);
  expect(workspace.vcsBinding).toBeUndefined();
  expect((await projectRegistry.get(workspace.projectId))!.vcsProviderId).toBe("jj");
  const service = resolveWorkspaceVcsService({
    projects: projectRegistry,
    workspaces: workspaceRegistry,
    plugins,
  });
  await expect(
    service.withWorkspace(workspace.workspaceId, undefined, async () => "must not run"),
  ).rejects.toMatchObject({ problem: { code: "unsupported-version" } });
  expect(calls).not.toContain("git");
  expect((await workspaceRegistry.get(workspace.workspaceId))!.cwd).toBe(cwd);
});

test("VCS project switching waits for both provider operations and legacy Git commands", async () => {
  const { createVcsHandler } = await import("@getpaseo/plugin/server/vcs");
  const { resolveWorkspaceVcsService } = await import("../../workspace-vcs-service.js");
  const { handleWorkspaceVcsRequest } = await import("../vcs/index.js");
  const cwd = path.join(tmpDir, "busy");
  mkdirSync(cwd);
  let release!: () => void;
  let started!: () => void;
  const running = new Promise<void>((resolve) => {
    started = resolve;
  });
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  const handler = createVcsHandler({
    id: "git",
    label: "Git",
    async detect(directory) {
      return {
        status: "available",
        binding: {
          providerId: "git",
          repositoryId: "repo",
          workingCopyId: directory,
          root: directory,
          cwd: directory,
        },
      };
    },
    async snapshot(binding) {
      return {
        binding,
        version: "1",
        current: null,
        files: [],
        refs: [],
        capabilities: ["actions"],
        actions: [{ id: "wait", enabled: true }],
        state: "ready",
      };
    },
    async history() {
      return { revisions: [] };
    },
    async diff() {
      return "";
    },
    async execute() {
      started();
      await wait;
      return {};
    },
  });
  const plugins = {
    listVcsProviders: () => [{ id: "git", pluginId: "git-vcs", label: "Git" }],
    invokeVcs: async (_id: string, request: import("@getpaseo/protocol/vcs").VcsRequest) =>
      handler.handle(request),
  };
  const deps = { projects: projectRegistry, workspaces: workspaceRegistry, plugins };
  provisioning = createWorkspaceProvisioningService({
    workspaceRegistry,
    projectRegistry,
    workspaceGitService: gitService(),
    isDirectory,
    logger,
    vcsPlugins: plugins,
  });
  const workspace = await provisioning.createWorkspaceForDirectory(cwd);
  const service = resolveWorkspaceVcsService(deps);
  try {
    await handleWorkspaceVcsRequest(
      {
        type: "vcs.actions.execute.request",
        requestId: "execute",
        workspaceId: workspace.workspaceId,
        version: "1",
        action: "wait",
        input: {},
        operationId: "busy",
      },
      deps,
    );
    await running;
    await expect(service.selectProjectProvider(workspace.projectId, "git")).rejects.toThrow(
      "Wait for running VCS operations",
    );
    release();
    await expect
      .poll(() =>
        handleWorkspaceVcsRequest(
          {
            type: "vcs.operations.get.request",
            requestId: "get",
            workspaceId: workspace.workspaceId,
            providerId: "git",
            operationId: "busy",
          },
          deps,
        ),
      )
      .toMatchObject({ payload: { result: { status: "succeeded" } } });
    await service.selectProjectProvider(workspace.projectId, "git");
    let releaseGit!: () => void;
    let startedGit!: () => void;
    const gitRunning = new Promise<void>((resolve) => {
      startedGit = resolve;
    });
    const gitWait = new Promise<void>((resolve) => {
      releaseGit = resolve;
    });
    const git = service.runLegacyGit(cwd, async () => {
      startedGit();
      await gitWait;
    });
    try {
      await gitRunning;
      await expect(service.selectProjectProvider(workspace.projectId, "git")).rejects.toThrow(
        "Wait for running Git operations",
      );
    } finally {
      releaseGit();
      await git;
    }
    expect(await service.selectProjectProvider(workspace.projectId, "git")).toEqual({
      projectId: workspace.projectId,
      providerId: "git",
    });
  } finally {
    release();
    handler.dispose();
  }
});

test.each(["git", "jj"])(
  "VCS working-copy creation preserves subdirectory cwd and ownership for %s",
  async (providerId) => {
    const { execCommand } = await import("@getpaseo/plugin/server");
    const { createVcsHandler } = await import("@getpaseo/plugin/server/vcs");
    const { jjProvider } = await import("../../../../../../plugins/jj-vcs/server/provider.js");
    const { gitProvider } = await import("../../../../../../plugins/git-vcs/server/provider.js");
    const { writeFile, readFile } = await import("node:fs/promises");
    const cwd = path.join(tmpDir, "repository");
    mkdirSync(path.join(cwd, "sub"), { recursive: true });
    await execCommand("git", ["init", cwd]);
    await execCommand("git", ["-C", cwd, "config", "user.name", "VCS Test"]);
    await execCommand("git", ["-C", cwd, "config", "user.email", "vcs@example.test"]);
    await writeFile(path.join(cwd, "sub", "file.txt"), "tracked content\n");
    await execCommand("git", ["-C", cwd, "add", "."]);
    await execCommand("git", ["-C", cwd, "commit", "-m", "initial"]);
    if (providerId === "jj") await execCommand("jj", ["git", "init", "--colocate", cwd]);
    const handler = createVcsHandler(providerId === "jj" ? jjProvider : gitProvider);
    const events: string[] = [];
    const plugins = {
      listVcsProviders: () => [
        { id: providerId, label: providerId, pluginId: `${providerId}-vcs` },
      ],
      invokeVcs: async (_id: string, request: import("@getpaseo/protocol/vcs").VcsRequest) =>
        handler.handle(request),
    };
    const service = createWorkspaceProvisioningService({
      workspaceRegistry,
      projectRegistry,
      workspaceGitService: gitService(),
      isDirectory,
      logger,
      vcsPlugins: plugins,
      paseoHome: path.join(tmpDir, "home"),
      lifecycle: {
        before: async (name, request) => {
          events.push(name);
          return request;
        },
        wait: async (name, payload) => {
          events.push(name);
          if (name === "working-copy.create.after" && "workingCopy" in payload)
            await writeFile(
              path.join(payload.workingCopy.binding.root, "hook.txt"),
              "before setup\n",
            );
        },
        emit: (name) => {
          events.push(name);
        },
      },
    });
    try {
      const project = await service.findOrCreateProjectForDirectory(path.join(cwd, "sub"));
      const { handleWorkspaceVcsRequest } = await import("../vcs/index.js");
      const deps = { projects: projectRegistry, workspaces: workspaceRegistry, plugins };
      // New workspace must resolve the project before any workspace has been created.
      const snapshotResponse = await handleWorkspaceVcsRequest(
        {
          type: "vcs.project.snapshot.get.request",
          requestId: "project-snapshot",
          projectId: project.projectId,
        },
        deps,
      );
      if (
        snapshotResponse.type !== "vcs.project.snapshot.get.response" ||
        !snapshotResponse.payload.result?.snapshot
      )
        throw new Error(JSON.stringify(snapshotResponse));
      const snapshot = snapshotResponse.payload.result.snapshot;
      expect(snapshot.binding.cwd).toBe(path.join(cwd, "sub"));
      const prepareRequest = {
        type: "vcs.project.working-copy.resolve-source.request" as const,
        requestId: "prepare-source",
        projectId: project.projectId,
        providerId,
        input: {
          version: 1,
          data: {
            kind: "branch",
            ref: snapshot.refs.find((ref) => ref.kind === "branch")?.id ?? "unused",
          },
        },
      };
      const prepared = await handleWorkspaceVcsRequest(prepareRequest, deps);
      if (providerId === "git") {
        expect(prepared.payload).toMatchObject({
          error: null,
          result: {
            revision: snapshot.current!.id,
            data: { version: 2, data: { source: prepareRequest.input.data } },
          },
        });
        expect(
          await handleWorkspaceVcsRequest(
            { ...prepareRequest, input: { version: 99, data: {} } },
            deps,
          ),
        ).toMatchObject({ payload: { result: null, error: { code: "provider" } } });
      } else {
        expect(prepared.payload).toMatchObject({
          result: null,
          error: {
            code: "unavailable",
            message: "Provider does not support working-copy source preparation",
          },
        });
      }
      expect(
        await handleWorkspaceVcsRequest({ ...prepareRequest, providerId: "changed" }, deps),
      ).toMatchObject({ payload: { result: null, error: { code: "outdated" } } });
      expect(
        await handleWorkspaceVcsRequest({ ...prepareRequest, projectId: "missing" }, deps),
      ).toMatchObject({ payload: { result: null, error: { code: "unavailable" } } });
      expect(events).toEqual([]);
      const historyRequest = {
        type: "vcs.project.history.list.request" as const,
        requestId: "project-history",
        projectId: project.projectId,
        providerId,
        version: snapshot.version,
        limit: 50,
      };
      expect(await handleWorkspaceVcsRequest(historyRequest, deps)).toMatchObject({
        payload: {
          error: null,
          result: {
            revisions: expect.arrayContaining([
              expect.objectContaining({ id: snapshot.current!.id }),
            ]),
          },
        },
      });
      expect(
        await handleWorkspaceVcsRequest({ ...historyRequest, providerId: "changed" }, deps),
      ).toMatchObject({ payload: { error: { code: "outdated" } } });
      await expect(
        service.createWorkspaceForWorkingCopy({
          projectId: project.projectId,
          providerId: "another-provider",
        }),
      ).rejects.toThrow("Project VCS changed");
      expect(events).toEqual([]);
      const options = providerId === "git" ? { branch: "custom-copy" } : { name: "custom-copy" };
      await expect(
        service.createWorkspaceForWorkingCopy({
          projectId: project.projectId,
          providerData: { version: 99, data: options },
        }),
      ).rejects.toThrow();
      const invalidRoot = path.join(
        tmpDir,
        "home",
        "working-copies",
        project.projectId,
        "wks_0123456789abcdef",
      );
      await expect(
        service.createWorkspaceForWorkingCopy({
          projectId: project.projectId,
          workspaceId: "wks_0123456789abcdef",
          providerData: {
            version: 1,
            data: providerId === "git" ? { branch: "../bad" } : { name: "../bad" },
          },
        }),
      ).rejects.toThrow();
      expect(existsSync(invalidRoot)).toBe(false);
      events.length = 0;
      const workspace = await service.createWorkspaceForWorkingCopy({
        projectId: project.projectId,
        providerId,
        providerData: { version: 1, data: options },
        title: "Isolated",
        background: true,
      });
      const root = workspace.vcsWorkingCopy!.binding.root;
      const name =
        providerId === "git"
          ? await execCommand("git", ["branch", "--show-current"], { cwd: root })
          : await execCommand("jj", ["workspace", "root", "--name", "custom-copy"], { cwd: root });
      expect(name.stdout.trim()).toBe(providerId === "git" ? "custom-copy" : root);
      expect(workspace.cwd).toBe(path.join(root, "sub"));
      expect(workspace.vcsBinding).toMatchObject({ providerId, root, cwd: workspace.cwd });
      expect(workspace.vcsWorkingCopy).toMatchObject({
        owned: true,
        binding: { cwd: workspace.cwd },
      });
      expect(workspace.branch).toBeNull();
      expect(workspace.isPaseoOwnedWorktree).toBe(false);
      expect(workspace.background).toBe(true);
      expect(await readFile(path.join(workspace.cwd, "file.txt"), "utf8")).toBe(
        "tracked content\n",
      );
      expect(await readFile(path.join(root, "hook.txt"), "utf8")).toBe("before setup\n");
      expect(events).toEqual([
        "working-copy.create.before",
        "working-copy.create.after",
        "workspace.create.after",
      ]);
      const reloaded = new FileBackedWorkspaceRegistry(
        path.join(tmpDir, "projects", "workspaces.json"),
        logger,
      );
      await reloaded.initialize();
      expect((await reloaded.get(workspace.workspaceId))!.vcsWorkingCopy).toEqual(
        workspace.vcsWorkingCopy,
      );
    } finally {
      handler.dispose();
    }
  },
);

test.each([
  { providerId: "git", change: "none" },
  { providerId: "jj", change: "none" },
  { providerId: "jj", change: "tracked" },
  { providerId: "jj", change: "ignored" },
  { providerId: "jj", change: "untracked" },
  { providerId: "jj", change: "snapshotted" },
])(
  "VCS working-copy rollback after a failed hook: $providerId / $change",
  async ({ providerId, change }) => {
    const { writeFile, readFile } = await import("node:fs/promises");
    let changedFile = "tracked.txt";
    if (change === "ignored") changedFile = "ignored.txt";
    if (change === "untracked") changedFile = "new.txt";
    const { execCommand } = await import("@getpaseo/plugin/server");
    const { createVcsHandler } = await import("@getpaseo/plugin/server/vcs");
    const { jjProvider } = await import("../../../../../../plugins/jj-vcs/server/provider.js");
    const { gitProvider } = await import("../../../../../../plugins/git-vcs/server/provider.js");
    const cwd = path.join(tmpDir, "repository");
    await execCommand("git", ["init", cwd]);
    await writeFile(path.join(cwd, "tracked.txt"), "original\n");
    await writeFile(path.join(cwd, ".gitignore"), "ignored.txt\n");
    await execCommand("git", ["add", "."], { cwd });
    await execCommand(
      "git",
      [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.test",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "--allow-empty",
        "-m",
        "initial",
      ],
      { cwd },
    );
    if (providerId === "jj") await execCommand("jj", ["git", "init", "--colocate", cwd]);
    const handler = createVcsHandler(providerId === "jj" ? jjProvider : gitProvider);
    const workspaceId = "wks_0123456789abcdef";
    const service = createWorkspaceProvisioningService({
      workspaceRegistry,
      projectRegistry,
      workspaceGitService: gitService(),
      isDirectory,
      logger,
      paseoHome: path.join(tmpDir, "home"),
      vcsPlugins: {
        listVcsProviders: () => [
          { id: providerId, label: providerId, pluginId: `${providerId}-vcs` },
        ],
        invokeVcs: async (_id, request) => handler.handle(request),
      },
      lifecycle: {
        before: async (_name, request) => request,
        emit: () => {},
        wait: async (_name, payload) => {
          if (change !== "none") {
            const root = payload.workingCopy.binding.root;
            await writeFile(path.join(root, changedFile), "retain me\n");
            if (change === "snapshotted") await execCommand("jj", ["status"], { cwd: root });
          }
          throw new Error("include failed");
        },
      },
    });
    try {
      const project = await service.findOrCreateProjectForDirectory(cwd);
      await expect(
        service.createWorkspaceForWorkingCopy({ projectId: project.projectId, workspaceId }),
      ).rejects.toThrow(change === "none" ? "include failed" : "Cleanup failed");
      expect(
        await isDirectory(
          path.join(tmpDir, "home", "working-copies", project.projectId, workspaceId),
        ),
      ).toBe(change !== "none");
      expect(await workspaceRegistry.list()).toEqual([]);
      const listing =
        providerId === "jj"
          ? await execCommand("jj", ["workspace", "list"], { cwd })
          : await execCommand("git", ["branch", "--list"], { cwd });
      if (change === "none") expect(listing.stdout).not.toContain(workspaceId);
      else {
        expect(listing.stdout).toContain(workspaceId);
        const root = path.join(tmpDir, "home", "working-copies", project.projectId, workspaceId);
        expect(await readFile(path.join(root, changedFile), "utf8")).toBe("retain me\n");
      }
      expect(await isDirectory(cwd)).toBe(true);
    } finally {
      handler.dispose();
    }
  },
);
