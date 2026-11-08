import { useEffect, useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { v4 as uuid } from "uuid";
import { useFetchQuery } from "@/data/query";
import { vcsQueryKey, useWorkspaceVcs } from "./queries";
import type { VcsOperationRequest, VcsPaneState } from "./state";

export function useVcsOperation(input: {
  serverId: string;
  workspaceId: string;
  enabled: boolean;
  state: VcsPaneState;
  setState(state: VcsPaneState): void;
}) {
  const { serverId, workspaceId, state, setState } = input;
  const starting = useRef(false);
  const { t } = useTranslation();
  const completion = useRef<{
    id: string;
    resolve(): void;
    reject(error: Error): void;
  } | null>(null);
  useEffect(
    () => () => {
      completion.current?.reject(new Error("VCS surface closed"));
      completion.current = null;
    },
    [],
  );
  const { vcs, connected } = useWorkspaceVcs(serverId, workspaceId);
  const cache = useQueryClient();
  const saved = state.operation;
  const key = [...vcsQueryKey(serverId, workspaceId), "operation", saved?.providerId, saved?.id];
  const submit = useMutation({
    mutationFn: async (operation: NonNullable<VcsPaneState["operation"]>) => {
      if (!vcs) throw new Error("Host is unavailable");
      const request = operation.request;
      return request.kind === "action"
        ? vcs.execute(operation.providerId, {
            operationId: operation.id,
            version: request.version,
            action: request.action,
            input: request.input,
          })
        : vcs.publication.execute(
            { operationId: operation.id, target: request.target, input: request.input },
            operation.providerId,
          );
    },
    onSuccess: (operation, descriptor) => {
      cache.setQueryData(
        [...vcsQueryKey(serverId, workspaceId), "operation", descriptor.providerId, descriptor.id],
        operation,
      );
    },
  });
  const query = useFetchQuery({
    dataShape: "value",
    staleTimeMs: 0,
    queryKey: key,
    enabled: input.enabled && connected && !!vcs && !!saved && !submit.isPending,
    retry: false,
    refetchInterval: (current) =>
      ["pending", "running"].includes(current.state.data?.status ?? "pending") ? 750 : false,
    queryFn: () => {
      if (!vcs || !saved) throw new Error("No VCS operation");
      return vcs.operation(saved.providerId, saved.id);
    },
  });
  const status = query.data?.status;
  useEffect(() => {
    if (!status || status === "pending" || status === "running") return;
    starting.current = false;
    const waiter = completion.current;
    if (waiter && waiter.id === query.data?.id) {
      completion.current = null;
      if (status === "succeeded") waiter.resolve();
      else waiter.reject(new Error(query.data?.error?.message ?? t("vcs.operationUnknown")));
    }
    void cache.invalidateQueries({ queryKey: [...vcsQueryKey(serverId, workspaceId), "snapshot"] });
    void cache.invalidateQueries({ queryKey: [...vcsQueryKey(serverId, workspaceId), "history"] });
    void cache.invalidateQueries({ queryKey: [...vcsQueryKey(serverId, workspaceId), "diff"] });
  }, [cache, serverId, workspaceId, saved?.id, status, query.data, t]);
  const pending =
    submit.isPending || (!!saved && (!query.data || status === "pending" || status === "running"));
  const { mutateAsync } = submit;
  const start = useCallback(
    async (providerId: string, request: VcsOperationRequest, waitForCompletion = false) => {
      if (pending || starting.current) throw new Error("Wait for the current VCS operation");
      starting.current = true;
      const descriptor = { providerId, id: uuid(), request };
      setState({ ...state, operation: descriptor });
      const completed = waitForCompletion
        ? new Promise<void>((resolve, reject) => {
            completion.current = { id: descriptor.id, resolve, reject };
          })
        : Promise.resolve();
      await Promise.all([
        mutateAsync(descriptor).catch(() => {
          /* Lookup resolves a lost acknowledgement without repeating the mutation. */
        }),
        completed,
      ]);
    },
    [pending, setState, state, mutateAsync],
  );
  return {
    start,
    pending,
    operation: query.data,
    error: query.error ?? (query.data ? null : submit.error),
    refresh: query.refetch,
  };
}
