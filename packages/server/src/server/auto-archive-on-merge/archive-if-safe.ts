import type { WorkspaceVcsService } from "../workspace-vcs-service.js";
import type { WorkspacePublicationStatus } from "../workspace-publication-service.js";
import type { Logger } from "pino";

import type { AgentManager } from "../agent/agent-manager.js";
import type { AgentStorage } from "../agent/agent-storage.js";
import type { DaemonConfigStore } from "../daemon-config-store.js";
import {
  archiveByScope,
  type ActiveWorkspaceRef,
  killTerminalsForWorkspace,
} from "../workspace-archive-service.js";
import type {
  WorkspaceGitRuntimeSnapshot,
  WorkspaceGitServiceImpl,
} from "../workspace-git-service.js";
import type { ForgeService } from "../../services/forge-service.js";
import type { TerminalManager } from "../../terminal/terminal-manager.js";
import { isPaseoOwnedWorktreeCwd } from "../../utils/worktree.js";
import type { WorkspaceArchiveContext } from "../workspace-registry.js";

export interface AutoArchiveArchiveOptions {
  vcs?: WorkspaceVcsService;
  paseoHome: string;
  paseoWorktreesBaseRoot?: string;
  daemonConfigStore: DaemonConfigStore;
  workspaceGitService: WorkspaceGitServiceImpl;
  github: ForgeService;
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  terminalManager: TerminalManager;
  findWorkspaceIdForCwd: (cwd: string) => Promise<string | null>;
  listActiveWorkspaces: () => Promise<ActiveWorkspaceRef[]>;
  getAutoArchivedChangeRequestUrl: (workspaceId: string) => Promise<string | null>;
  archiveWorkspaceRecord: (workspaceId: string, context?: WorkspaceArchiveContext) => Promise<void>;
  markWorkspaceArchiving: (workspaceIds: Iterable<string>, archivingAt: string) => void;
  clearWorkspaceArchiving: (workspaceIds: Iterable<string>) => void;
  emitWorkspaceUpdatesForWorkspaceIds: (workspaceIds: Iterable<string>) => Promise<void>;
}

export interface ArchiveIfSafeDependencies {
  archiveByScope: typeof archiveByScope;
  isPaseoOwnedWorktreeCwd: typeof isPaseoOwnedWorktreeCwd;
  killTerminalsForWorkspace: typeof killTerminalsForWorkspace;
}

const defaultDependencies: ArchiveIfSafeDependencies = {
  archiveByScope,
  isPaseoOwnedWorktreeCwd,
  killTerminalsForWorkspace,
};

export async function archiveIfSafe(input: {
  workspaceId: string;
  snapshot: WorkspaceGitRuntimeSnapshot;
  options: AutoArchiveArchiveOptions;
  log: Logger;
  deps?: ArchiveIfSafeDependencies;
}): Promise<void> {
  const { workspaceId, snapshot, options, log } = input;
  const deps = input.deps ?? defaultDependencies;
  const cwd = snapshot.cwd;
  const pullRequest = snapshot.forge.pullRequest;

  if (!pullRequest?.isMerged) {
    return;
  }
  if (snapshot.git.isDirty === true) {
    return;
  }
  if (typeof snapshot.git.aheadOfOrigin === "number" && snapshot.git.aheadOfOrigin > 0) {
    return;
  }

  const attached = (await options.listActiveWorkspaces()).find(
    (workspace) => workspace.workspaceId === workspaceId,
  );
  // A provider-managed copy must be judged by its own publication state, including in colocated repositories.
  if (attached?.vcsWorkingCopy) return;
  const providerId =
    attached?.projectId && options.vcs
      ? (await options.vcs.getProjectSelection(attached.projectId)).providerId
      : attached?.vcsBinding?.providerId;
  if (providerId && providerId !== "git") return;
  const ownership = await deps.isPaseoOwnedWorktreeCwd(cwd, {
    paseoHome: options.paseoHome,
    worktreesRoot: options.paseoWorktreesBaseRoot,
  });
  if (!ownership.allowed) {
    return;
  }

  await archiveMergedWorkspace({ workspaceId, cwd, pullRequest, options, log, deps });
}

export async function archivePublicationIfSafe(input: {
  event: WorkspacePublicationStatus;
  options: AutoArchiveArchiveOptions;
  log: Logger;
  deps?: ArchiveIfSafeDependencies;
}): Promise<void> {
  const { event, options, log } = input;
  if (!event.status?.isMerged || !options.vcs) return;
  const canArchive = () =>
    options.vcs!.publication.canArchive(event.workspaceId, event.binding.providerId, event.target);
  if (!(await canArchive())) return;
  const fresh = await options.vcs.publication.status(
    event.workspaceId,
    event.binding,
    event.target,
    { force: true },
  );
  if (!fresh.status?.isMerged || fresh.status.url !== event.status.url) return;
  await archiveMergedWorkspace({
    workspaceId: event.workspaceId,
    cwd: event.binding.cwd,
    pullRequest: fresh.status,
    options,
    log,
    deps: input.deps ?? defaultDependencies,
    canArchive,
  });
}

async function archiveMergedWorkspace(input: {
  workspaceId: string;
  cwd: string;
  pullRequest: { url: string; headRefName: string };
  options: AutoArchiveArchiveOptions;
  log: Logger;
  deps: ArchiveIfSafeDependencies;
  canArchive?: () => Promise<boolean>;
}): Promise<void> {
  const { workspaceId, cwd, pullRequest, options, log, deps } = input;

  try {
    const autoArchivedChangeRequestUrl = await options.getAutoArchivedChangeRequestUrl(workspaceId);
    if (autoArchivedChangeRequestUrl === pullRequest.url) {
      return;
    }

    await deps.archiveByScope(
      {
        vcs: options.vcs,
        paseoHome: options.paseoHome,
        paseoWorktreesBaseRoot: options.paseoWorktreesBaseRoot,
        github: options.github,
        workspaceGitService: options.workspaceGitService,
        agentManager: options.agentManager,
        agentStorage: options.agentStorage,
        findWorkspaceIdForCwd: options.findWorkspaceIdForCwd,
        listActiveWorkspaces: options.listActiveWorkspaces,
        archiveWorkspaceRecord: async (workspaceIdToArchive) => {
          if (input.canArchive && !(await input.canArchive()))
            throw new Error(
              "Working copy changed before auto-archive; keeping the workspace active",
            );
          await options.archiveWorkspaceRecord(workspaceIdToArchive, {
            autoArchivedChangeRequestUrl: pullRequest.url,
          });
        },
        emitWorkspaceUpdatesForWorkspaceIds: options.emitWorkspaceUpdatesForWorkspaceIds,
        markWorkspaceArchiving: options.markWorkspaceArchiving,
        clearWorkspaceArchiving: options.clearWorkspaceArchiving,
        killTerminalsForWorkspace: (workspaceIdToKill) =>
          deps.killTerminalsForWorkspace(
            {
              terminalManager: options.terminalManager,
              sessionLogger: log,
            },
            workspaceIdToKill,
          ),
        sessionLogger: log,
      },
      {
        scope: { kind: "workspace", workspaceId },
        requestId: "auto-archive-on-merge",
      },
    );
    log.info(
      { workspaceId, cwd, branch: pullRequest.headRefName, pullRequestUrl: pullRequest.url },
      "Auto-archived worktree after PR merge",
    );
  } catch (error) {
    log.warn({ err: error, cwd }, "Auto-archive after merge failed");
  }
}
