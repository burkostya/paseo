import { type PluginAgentPanelProps, useRpc } from "@getpaseo/plugin/client";
import { useMemo, useCallback } from "react";
import { Button } from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ScrollView, Text } from "react-native";
import {
  startReview,
  getReview,
  cancelReview,
  retryReview,
  type ReviewState,
} from "../shared/review";

export function ReviewPanel({
  theme,
  host,
  workspaceId,
  params,
  navigation,
}: PluginAgentPanelProps) {
  const start = useRpc(startReview);
  const get = useRpc(getReview);
  const cancel = useRpc(cancelReview);
  const retry = useRpc(retryReview);
  const cache = useQueryClient();
  const target = { agentId: params.agentId, workspaceId };
  const queryKey = ["plannotator-review", host.id, workspaceId, params.agentId];
  const openBrowser = navigation?.openBrowser;
  const query = useQuery({
    queryKey,
    queryFn: () => get(target),
    enabled: Boolean(openBrowser),
    refetchInterval: 1000,
  });
  const action = useMutation({
    mutationFn: async (operation: "start" | "open" | "cancel" | "retry") => {
      let state: ReviewState | null = query.data ?? null;
      if (operation === "start") state = await start(target);
      if (!state) throw new Error("No review is available");
      const input = { ...target, reviewId: state.id };
      if (operation === "cancel") state = await cancel(input);
      if (operation === "retry") state = await retry(input);
      cache.setQueryData(queryKey, state);
      if ((operation === "start" || operation === "open") && state.url) {
        openBrowser?.({ url: state.url, workspaceId, serverId: host.id });
      }
      return state;
    },
  });
  const state = query.data;
  const busy = action.isPending || query.isPending;
  const running = state?.status === "starting" || state?.status === "reviewing";
  const canStart = !state || ["sent", "cancelled", "failed"].includes(state.status);
  const styles = useMemo(
    () => ({
      text: { color: theme.colors.foreground },
      muted: { color: theme.colors.foregroundMuted },
      error: { color: theme.colors.statusDanger },
      content: { padding: 20, gap: 16, backgroundColor: theme.colors.surface0 },
    }),
    [theme],
  );
  const { mutate } = action;
  const onStart = useCallback(() => mutate("start"), [mutate]);
  const onOpen = useCallback(() => mutate("open"), [mutate]);
  const onCancel = useCallback(() => mutate("cancel"), [mutate]);
  const onRetry = useCallback(() => mutate("retry"), [mutate]);
  const error = action.error ?? query.error;
  if (!openBrowser)
    return (
      <Text style={styles.text}>
        Code review requires Paseo Electron and a daemon on this computer.
      </Text>
    );
  return (
    <ScrollView contentContainerStyle={styles.content}>
      <Text style={styles.text}>Plannotator · Code review</Text>
      <Text style={styles.muted}>
        Local daemon only. Review staged, unstaged and untracked changes. Closing the browser tab
        keeps the review running.
      </Text>
      <Text style={styles.text}>{state?.status ?? "Ready"}</Text>
      {canStart && (
        <Button disabled={busy} onPress={onStart}>
          <Text style={styles.text}>{action.isPending ? "Starting…" : "Review changes"}</Text>
        </Button>
      )}
      {state?.url && (
        <Button disabled={busy} onPress={onOpen}>
          <Text style={styles.text}>Open review</Text>
        </Button>
      )}
      {running && (
        <Button disabled={busy} onPress={onCancel}>
          <Text style={styles.text}>Cancel review</Text>
        </Button>
      )}
      {state?.status === "delivery-failed" && (
        <Button disabled={busy} onPress={onRetry}>
          <Text style={styles.text}>Retry delivery (check the agent first)</Text>
        </Button>
      )}
      <ReviewResult state={state ?? null} error={error} styles={styles} />
    </ScrollView>
  );
}
interface ResultProps {
  state: ReviewState | null;
  error: Error | null;
  styles: { text: { color: string }; error: { color: string } };
}
function ReviewResult({ state, error, styles }: ResultProps) {
  return (
    <>
      {error && <Text style={styles.error}>{error.message}</Text>}
      {state?.error && <Text style={styles.error}>{state.error}</Text>}
      {state?.message && (
        <Text selectable style={styles.text}>
          {state.message}
        </Text>
      )}
    </>
  );
}
