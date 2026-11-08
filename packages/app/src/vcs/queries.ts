import { useQueryClient } from "@tanstack/react-query";
import type { VcsSnapshotValue, VcsSnapshotRoute } from "./snapshot-router";
import { useMemo, useCallback } from "react";
import { useWorkspace } from "@/stores/session-store-hooks";
import { useHostFeature } from "@/runtime/host-features";
import { createPaseoApi, type PaseoWorkspaceVcs } from "@getpaseo/client";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useFetchQuery, useInfiniteFetchQuery, useReplicaQuery } from "@/data/query";
import type { VcsComparison, VcsSnapshot } from "@getpaseo/protocol/vcs";

export const vcsQueryKey = (serverId: string, workspaceId: string) =>
  ["workspace-vcs", serverId, workspaceId] as const;
export function useWorkspaceVcs(serverId: string, workspaceId: string) {
  const workspace = useWorkspace(serverId, workspaceId);
  const providerId = workspace?.vcsProviderId;
  const identity = useMemo(
    () => [providerId, workspace?.projectRootPath, workspace?.workspaceDirectory],
    [providerId, workspace?.projectRootPath, workspace?.workspaceDirectory],
  );
  const client = useHostRuntimeClient(serverId);
  const connected = useHostRuntimeIsConnected(serverId);
  const vcs = useMemo(
    () => (client ? createPaseoApi(client).workspaces.ref(workspaceId).vcs : null),
    [client, workspaceId],
  );
  return { vcs, connected, providerId, identity };
}
export function useVcsSnapshot(
  serverId: string,
  workspaceId: string,
  enabled: boolean,
): VcsSnapshotQuery {
  const observed = useHostFeature(serverId, "vcsObservation");
  const subscription = useObservedVcsSnapshot(serverId, workspaceId, enabled && observed);
  // COMPAT(vcsObservation): added in v0.15.2, remove after 2027-06-06 when older VCS hosts expire.
  const read = useReadVcsSnapshot(serverId, workspaceId, enabled && !observed);
  return observed ? subscription : read;
}
// COMPAT(vcsObservation): added in v0.15.2, remove after 2027-06-06 with the explicit-read hook.
function useReadVcsSnapshot(serverId: string, workspaceId: string, enabled: boolean) {
  const { vcs, connected, providerId, identity } = useWorkspaceVcs(serverId, workspaceId);
  return useFetchQuery({
    dataShape: "value",
    staleTimeMs: 5_000,
    queryKey: [...vcsQueryKey(serverId, workspaceId), "snapshot", ...identity],
    enabled: enabled && connected && vcs !== null,
    retry: false,
    queryFn: () => {
      if (!vcs) throw new Error("Host is unavailable");
      return vcs.snapshot(providerId);
    },
  });
}
export interface VcsSnapshotQuery {
  data: VcsSnapshot | undefined;
  error: Error | null;
  isFetching: boolean;
  refetch(): Promise<unknown>;
}
function useObservedVcsSnapshot(
  serverId: string,
  workspaceId: string,
  enabled: boolean,
): VcsSnapshotQuery {
  const { connected, providerId, identity } = useWorkspaceVcs(serverId, workspaceId);
  const cache = useQueryClient();
  const queryKey = useMemo(
    () => [...vcsQueryKey(serverId, workspaceId), "snapshot", ...identity, "observed"],
    [serverId, workspaceId, identity],
  );
  const query = useReplicaQuery<VcsSnapshotValue>({
    queryKey,
    enabled: enabled && connected,
    pushEvent: "vcs.snapshot.changed",
    meta: {
      vcsSnapshot: {
        serverId,
        workspaceId,
        providerId,
        enabled: enabled && connected,
      } satisfies VcsSnapshotRoute,
    },
  });
  const refetch = useCallback(
    () => cache.invalidateQueries({ queryKey, exact: true }),
    [cache, queryKey],
  );
  return {
    data: query.data?.result ?? undefined,
    error: query.data?.error ? new Error(query.data.error.message) : query.error,
    isFetching: query.isFetching,
    refetch,
  };
}
export function useVcsHistory(
  serverId: string,
  workspaceId: string,
  snapshot: VcsSnapshot | undefined,
  enabled: boolean,
) {
  const { vcs, connected, providerId, identity } = useWorkspaceVcs(serverId, workspaceId);
  return useInfiniteFetchQuery<
    Awaited<ReturnType<PaseoWorkspaceVcs["history"]>>,
    string | undefined
  >({
    staleTimeMs: 30_000,
    queryKey: [
      ...vcsQueryKey(serverId, workspaceId),
      "history",
      ...identity,
      snapshot?.binding,
      snapshot?.version,
    ],
    enabled:
      enabled && connected && vcs !== null && snapshot?.capabilities.includes("history") === true,
    retry: false,
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.cursor,
    queryFn: ({ pageParam }) => {
      if (!vcs) throw new Error("Host is unavailable");
      return vcs.history(providerId, { limit: 50, cursor: pageParam, version: snapshot?.version });
    },
  });
}
export function useVcsDiff(
  serverId: string,
  workspaceId: string,
  snapshot: VcsSnapshot | undefined,
  comparison: VcsComparison,
  enabled: boolean,
) {
  const { vcs, connected, providerId, identity } = useWorkspaceVcs(serverId, workspaceId);
  return useFetchQuery({
    dataShape: "value",
    staleTimeMs: 30_000,
    queryKey: [
      ...vcsQueryKey(serverId, workspaceId),
      "diff",
      ...identity,
      snapshot?.binding,
      snapshot?.version,
      comparison,
    ],
    enabled:
      enabled && connected && vcs !== null && snapshot?.capabilities.includes("diff") === true,
    retry: false,
    queryFn: async () => {
      if (!vcs) throw new Error("Host is unavailable");
      const result = await vcs.diff(providerId, comparison);
      if (!result.files) throw new Error("Update the host to display VCS diffs");
      return result.files;
    },
  });
}
