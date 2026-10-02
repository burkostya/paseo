import { realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { ProjectWorktreeCandidate } from "@getpaseo/protocol/messages";
import { runGitCommand } from "../utils/run-git-command.js";
import type { ProjectRegistry, WorkspaceRegistry } from "./workspace-registry.js";

interface Dependencies {
  projects: ProjectRegistry;
  workspaces: WorkspaceRegistry;
}

async function canonicalPath(path: string): Promise<string> {
  return realpath(path).catch(() => resolve(path));
}

export async function listProjectWorktrees(
  deps: Dependencies,
  projectId: string,
): Promise<ProjectWorktreeCandidate[]> {
  const project = await deps.projects.get(projectId);
  if (!project || project.archivedAt) throw new Error("Active project not found");
  const { stdout } = await runGitCommand(["worktree", "list", "--porcelain", "-z"], {
    cwd: project.rootPath,
    envOverlay: { GIT_OPTIONAL_LOCKS: "0" },
  });
  const records = (await deps.workspaces.list()).filter((record) => record.projectId === projectId);
  const paths = await Promise.all(records.map((record) => canonicalPath(record.cwd)));
  // Git lists the primary checkout (or bare repository) first. Only linked
  // worktrees belong in this picker. NUL records preserve spaces and newlines.
  return Promise.all(
    stdout
      .split("\0\0")
      .filter(Boolean)
      .slice(1)
      .map(async (block) => {
        const fields = block.split("\0");
        const path = await canonicalPath(fields[0].slice("worktree ".length));
        const branch = fields.find((field) => field.startsWith("branch "));
        const candidates = records.filter((_record, index) => paths[index] === path);
        const existing = candidates.find((record) => !record.archivedAt) ?? candidates[0];
        const available = await stat(path).then(
          (value) => value.isDirectory(),
          () => false,
        );
        return {
          path,
          branch: branch ? branch.slice("branch refs/heads/".length) : null,
          head: fields.find((field) => field.startsWith("HEAD "))?.slice(5) ?? "",
          unavailable: !available || fields.some((field) => field.startsWith("prunable")),
          workspaceId: existing?.workspaceId ?? null,
          archived: Boolean(existing?.archivedAt),
        };
      }),
  );
}

// All sessions share a registry. Serialize imports so retries and two clients
// cannot register the same worktree twice through this operation.
const imports = new WeakMap<WorkspaceRegistry, Promise<unknown>>();

export async function importProjectWorktree(
  deps: Dependencies & {
    create: (path: string) => Promise<string>;
    restore: (workspaceId: string) => Promise<void>;
  },
  projectId: string,
  path: string,
): Promise<string> {
  const previous = imports.get(deps.workspaces) ?? Promise.resolve();
  const operation = previous
    .catch(() => {})
    .then(async () => {
      const canonical = await canonicalPath(path);
      const candidates = await listProjectWorktrees(deps, projectId);
      const candidate = candidates.find((entry) => entry.path === canonical);
      if (!candidate || candidate.unavailable)
        throw new Error("Worktree is no longer available in this repository");
      // A directory can be replaced while Git still retains its worktree entry.
      // Verify the checkout itself before registering it or restoring sessions.
      const project = await deps.projects.get(projectId);
      if (!project || project.archivedAt) throw new Error("Active project not found");
      const gitOptions = { envOverlay: { GIT_OPTIONAL_LOCKS: "0" } };
      const [root, common, projectCommon] = await Promise.all([
        runGitCommand(["rev-parse", "--show-toplevel"], { ...gitOptions, cwd: candidate.path }),
        runGitCommand(["rev-parse", "--git-common-dir"], { ...gitOptions, cwd: candidate.path }),
        runGitCommand(["rev-parse", "--git-common-dir"], { ...gitOptions, cwd: project.rootPath }),
      ]);
      const [actualRoot, actualCommon, expectedCommon] = await Promise.all([
        canonicalPath(root.stdout.replace(/\r?\n$/, "")),
        canonicalPath(resolve(candidate.path, common.stdout.replace(/\r?\n$/, ""))),
        canonicalPath(resolve(project.rootPath, projectCommon.stdout.replace(/\r?\n$/, ""))),
      ]);
      if (actualRoot !== candidate.path || actualCommon !== expectedCommon) {
        throw new Error("Directory is no longer a worktree of this repository");
      }
      if (candidate.workspaceId) {
        if (candidate.archived) await deps.restore(candidate.workspaceId);
        return candidate.workspaceId;
      }
      return deps.create(candidate.path);
    });
  imports.set(deps.workspaces, operation);
  try {
    return await operation;
  } finally {
    if (imports.get(deps.workspaces) === operation) imports.delete(deps.workspaces);
  }
}
