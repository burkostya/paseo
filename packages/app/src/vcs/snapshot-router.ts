import type { QueryClient, Query, QueryKey } from "@tanstack/react-query";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { VcsSnapshot, VcsProblem } from "@getpaseo/protocol/vcs";

export interface VcsSnapshotValue {
  result: VcsSnapshot | null;
  error: VcsProblem | null;
}
export interface VcsSnapshotRoute {
  serverId: string;
  workspaceId: string;
  providerId?: string;
  enabled: boolean;
}
interface Registration {
  route: VcsSnapshotRoute;
  queryKey: QueryKey;
  subscription?: ReturnType<DaemonClient["observeVcsSnapshot"]>;
  failed: boolean;
  refreshing: boolean;
}
type Client = Pick<DaemonClient, "observeVcsSnapshot"> & {
  requestVcs(request: {
    type: "vcs.snapshot.get.request";
    workspaceId: string;
    providerId?: string;
  }): Promise<VcsSnapshot>;
};

/** One source per observed cache key; retained, hidden consumers create no demand. */
export function mountVcsSnapshotRouter(input: {
  client: Client;
  queryClient: QueryClient;
  serverId: string;
}) {
  const active = new Map<string, Registration>();
  let disposed = false;
  const apply = (key: string, owner: Registration, value: VcsSnapshotValue) => {
    if (active.get(key) === owner && !disposed)
      input.queryClient.setQueryData(owner.queryKey, value);
  };
  function start(query: Query, route: VcsSnapshotRoute) {
    const key = query.queryHash;
    const owner: Registration = {
      route,
      queryKey: query.queryKey,
      failed: false,
      refreshing: false,
    };
    active.set(key, owner);
    const error = (failure: unknown) => {
      owner.failed = true;
      apply(key, owner, {
        result: null,
        error: {
          code: "provider",
          message: failure instanceof Error ? failure.message : String(failure),
        },
      });
    };
    try {
      owner.subscription = input.client.observeVcsSnapshot(route.workspaceId, route.providerId);
      owner.subscription.subscribe({
        snapshot: (value) => apply(key, owner, value),
        update: (message) => {
          if (message.type === "vcs.snapshot.changed") apply(key, owner, message.payload);
        },
        error,
      });
    } catch (failure) {
      error(failure);
    }
  }
  function reconcile() {
    if (disposed) return;
    const wanted = new Set<string>();
    for (const query of input.queryClient.getQueryCache().getAll()) {
      const route = query.observers
        .map((observer) => observer.options.meta?.vcsSnapshot as VcsSnapshotRoute | undefined)
        .find((candidate) => candidate?.enabled && candidate.serverId === input.serverId);
      if (!route) continue;
      wanted.add(query.queryHash);
      if (!active.has(query.queryHash)) start(query, route);
    }
    for (const [key, owner] of active) {
      if (wanted.has(key)) continue;
      active.delete(key);
      void owner.subscription?.release().catch(console.error);
    }
  }
  async function refresh(query: Query, owner: Registration) {
    if (owner.refreshing) return;
    if (owner.failed) {
      active.delete(query.queryHash);
      await owner.subscription?.release();
      reconcile();
      return;
    }
    owner.refreshing = true;
    try {
      const result = await input.client.requestVcs({
        type: "vcs.snapshot.get.request",
        workspaceId: owner.route.workspaceId,
        providerId: owner.route.providerId,
      });
      apply(query.queryHash, owner, { result, error: null });
    } catch (error) {
      apply(query.queryHash, owner, {
        result: null,
        error: {
          code: "provider",
          message: error instanceof Error ? error.message : String(error),
        },
      });
    } finally {
      owner.refreshing = false;
    }
  }
  const stop = input.queryClient.getQueryCache().subscribe((event) => {
    if (event.type === "updated" && event.action.type === "invalidate") {
      const owner = active.get(event.query.queryHash);
      if (owner) void refresh(event.query, owner).catch(console.error);
    }
    if (
      (event.type === "observerAdded" ||
        event.type === "observerRemoved" ||
        event.type === "observerOptionsUpdated") &&
      (active.has(event.query.queryHash) ||
        event.query.observers.some(
          (observer) =>
            (observer.options.meta?.vcsSnapshot as VcsSnapshotRoute | undefined)?.serverId ===
            input.serverId,
        ))
    )
      reconcile();
  });
  reconcile();
  return () => {
    disposed = true;
    stop();
    for (const owner of active.values()) void owner.subscription?.release().catch(console.error);
    active.clear();
  };
}
