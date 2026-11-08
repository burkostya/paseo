import { resolve } from "node:path";
import { LRUCache } from "lru-cache";
import type { Logger } from "pino";

import {
  archivePublicationIfSafe,
  archiveIfSafe,
  type AutoArchiveArchiveOptions,
} from "./archive-if-safe.js";
import type {
  WorkspaceGitRuntimeSnapshot,
  WorkspaceGitSubscription,
} from "../workspace-git-service.js";

export interface AutoArchiveOnMergeOptions extends AutoArchiveArchiveOptions {
  logger: Logger;
}

export interface AutoArchiveOnMergeDependencies {
  archiveIfSafe: typeof archiveIfSafe;
  archivePublicationIfSafe?: typeof archivePublicationIfSafe;
  resolvePath: typeof resolve;
}

const OPEN_PULL_REQUEST_LATCH_MAX = 1_024;

const defaultDependencies: AutoArchiveOnMergeDependencies = {
  archiveIfSafe,
  resolvePath: resolve,
};

export function setupAutoArchiveOnMerge(
  options: AutoArchiveOnMergeOptions,
  deps: AutoArchiveOnMergeDependencies = defaultDependencies,
): WorkspaceGitSubscription {
  const log = options.logger.child({ module: "auto-archive-on-merge" });
  const inFlightCwds = new Set<string>();
  const openPullRequestUrlsByCwd = new LRUCache<string, string>({
    max: OPEN_PULL_REQUEST_LATCH_MAX,
  });

  const publicationUnsubscribe = subscribePublicationAutoArchive(
    options,
    log,
    deps.archivePublicationIfSafe ?? archivePublicationIfSafe,
  );
  const gitSubscription = options.workspaceGitService.onSnapshotUpdated((snapshot) => {
    const snapshotCwd = deps.resolvePath(snapshot.cwd);
    if (options.daemonConfigStore.get().autoArchiveAfterMerge !== true) {
      openPullRequestUrlsByCwd.delete(snapshotCwd);
      return;
    }

    const pullRequest = snapshot.forge.pullRequest;
    if (!pullRequest?.isMerged) {
      if (pullRequest?.state.toLowerCase() === "open") {
        openPullRequestUrlsByCwd.set(snapshotCwd, pullRequest.url);
      } else {
        openPullRequestUrlsByCwd.delete(snapshotCwd);
      }
      return;
    }
    if (openPullRequestUrlsByCwd.get(snapshotCwd) !== pullRequest.url) {
      openPullRequestUrlsByCwd.delete(snapshotCwd);
      return;
    }
    if (inFlightCwds.has(snapshotCwd)) {
      return;
    }
    inFlightCwds.add(snapshotCwd);

    void (async () => {
      let freshSnapshot: WorkspaceGitRuntimeSnapshot | null;
      try {
        freshSnapshot = await options.workspaceGitService.getSnapshot(snapshot.cwd, {
          reason: "auto-archive-on-merge",
        });
      } catch (error) {
        log.warn(
          { err: error, cwd: snapshot.cwd },
          "Failed to read snapshot for auto-archive; skipping",
        );
        return;
      }
      const freshPullRequest = freshSnapshot?.forge.pullRequest;
      if (
        !freshPullRequest?.isMerged ||
        freshPullRequest.url !== pullRequest.url ||
        openPullRequestUrlsByCwd.get(snapshotCwd) !== pullRequest.url
      ) {
        if (openPullRequestUrlsByCwd.get(snapshotCwd) === pullRequest.url) {
          openPullRequestUrlsByCwd.delete(snapshotCwd);
        }
        return;
      }

      const attachedWorkspaces = (await options.listActiveWorkspaces()).filter(
        (workspace) => deps.resolvePath(workspace.cwd) === snapshotCwd,
      );
      for (const workspace of attachedWorkspaces) {
        await deps.archiveIfSafe({
          workspaceId: workspace.workspaceId,
          snapshot: freshSnapshot,
          options,
          log,
        });
      }
    })()
      .catch((error) => {
        log.warn({ err: error, cwd: snapshot.cwd }, "Failed to auto-archive attached workspaces");
      })
      .finally(() => {
        inFlightCwds.delete(snapshotCwd);
      });
  });
  return {
    unsubscribe() {
      gitSubscription.unsubscribe();
      publicationUnsubscribe();
    },
  };
}

function subscribePublicationAutoArchive(
  options: AutoArchiveOnMergeOptions,
  log: Logger,
  archive: typeof archivePublicationIfSafe,
): () => void {
  const open = new LRUCache<string, string>({ max: OPEN_PULL_REQUEST_LATCH_MAX });
  const running = new Set<string>();
  return (
    options.vcs?.publication.subscribe((event) => {
      const id = event.workspaceId;
      if (options.daemonConfigStore.get().autoArchiveAfterMerge !== true) {
        open.delete(id);
        return;
      }
      const status = event.status;
      const identity = JSON.stringify([
        event.binding.providerId,
        event.binding.repositoryId,
        event.target.repositoryUrl,
        event.target.headRef,
        status?.url,
      ]);
      if (!status?.isMerged) {
        if (status?.state.toLowerCase() === "open") open.set(id, identity);
        else open.delete(id);
        return;
      }
      if (open.get(id) !== identity || running.has(id)) return;
      running.add(id);
      void archive({ event, options, log })
        .catch((error) =>
          log.warn({ err: error, workspaceId: id }, "Publication auto-archive failed"),
        )
        .finally(() => running.delete(id));
    }) ?? (() => {})
  );
}
