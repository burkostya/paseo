import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Square, SquareCheck } from "lucide-react-native";
import { Pressable, Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import type { ProjectWorktreeCandidate } from "@getpaseo/protocol/messages";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { useHosts, useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useHostFeature } from "@/runtime/host-features";
import { openWorktreeImportForm } from "@/projects/worktree-import-model";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";

const ThemedLoadingSpinner = withUnistyles(LoadingSpinner, (theme) => ({
  color: theme.colors.foregroundMuted,
}));
const ThemedSquare = withUnistyles(Square, (theme) => ({ color: theme.colors.foregroundMuted }));
const ThemedSquareCheck = withUnistyles(SquareCheck, (theme) => ({
  color: theme.colors.foreground,
}));

export interface WorktreeImportHost {
  serverId: string;
  projectId: string;
  serverName?: string;
}

export function ProjectWorktreeImportSheet({
  hosts,
  projectName,
  onClose,
}: {
  hosts: readonly WorktreeImportHost[];
  projectName: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [host, setHost] = useState<WorktreeImportHost | null>(() =>
    hosts.length === 1 ? hosts[0] : null,
  );
  const knownHosts = useHosts();
  const back = useCallback(() => setHost(null), []);
  const header = useMemo(
    () => ({
      title: t("worktreeImport.title"),
      subtitle: (
        <Text style={styles.muted}>
          {host
            ? `${projectName} · ${knownHosts.find((entry) => entry.serverId === host.serverId)?.label ?? host.serverId}`
            : projectName}
        </Text>
      ),
      back: host && hosts.length > 1 ? { onPress: back } : undefined,
    }),
    [t, host, knownHosts, hosts.length, back, projectName],
  );
  return (
    <AdaptiveModalSheet visible onClose={onClose} header={header}>
      {host ? (
        <HostImport key={`${host.serverId}:${host.projectId}`} host={host} onClose={onClose} />
      ) : (
        <View style={styles.content}>
          <Text style={styles.text}>{t("worktreeImport.chooseHost")}</Text>
          {hosts.map((entry) => (
            <HostChoice
              key={`${entry.serverId}:${entry.projectId}`}
              host={entry}
              label={
                knownHosts.find((known) => known.serverId === entry.serverId)?.label ??
                entry.serverId
              }
              onSelect={setHost}
            />
          ))}
        </View>
      )}
    </AdaptiveModalSheet>
  );
}

function HostChoice({
  host,
  label,
  onSelect,
}: {
  host: WorktreeImportHost;
  label: string;
  onSelect: (host: WorktreeImportHost) => void;
}) {
  const select = useCallback(() => onSelect(host), [onSelect, host]);
  return (
    <Button variant="outline" onPress={select}>
      {label}
    </Button>
  );
}

function HostImport({ host, onClose }: { host: WorktreeImportHost; onClose: () => void }) {
  const { t } = useTranslation();
  const client = useHostRuntimeClient(host.serverId);
  const connected = useHostRuntimeIsConnected(host.serverId);
  // COMPAT(projectWorktreeImport): added in v0.11.0, remove after 2027-04-02 once daemon floor >= v0.11.0.
  const supported = useHostFeature(host.serverId, "projectWorktreeImport");
  if (!connected || !client)
    return <Text style={styles.text}>{t("sidebar.project.toasts.hostDisconnected")}</Text>;
  if (!supported) return <Text style={styles.text}>{t("worktreeImport.updateHost")}</Text>;
  return <ImportForm client={client} host={host} onClose={onClose} />;
}

function useWorktreeImportForm(client: DaemonClient, projectId: string) {
  const [model] = useState(() =>
    openWorktreeImportForm({
      list: () => client.listProjectWorktrees(projectId),
      import: (path) => client.importProjectWorktree(projectId, path),
    }),
  );
  const lifetime = useRef({ generation: 0 });
  useEffect(() => {
    const lifecycle = lifetime.current;
    const current = ++lifecycle.generation;
    void model.refresh();
    // Strict Mode replays effect setup before this microtask. Only an actual
    // unmount destroys the form; the replay still uses its original instance.
    return () =>
      queueMicrotask(() => {
        if (lifecycle.generation === current) model.close();
      });
  }, [model]);
  const state = useSyncExternalStore(model.subscribe, model.getState, model.getState);
  return { model, state };
}

function ImportForm({
  client,
  host,
  onClose,
}: {
  client: DaemonClient;
  host: WorktreeImportHost;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { model, state } = useWorktreeImportForm(client, host.projectId);
  const busy = state.status === "importing";
  const refresh = useCallback(() => {
    void model.refresh();
  }, [model]);
  const submit = useCallback(() => {
    void model.submit();
  }, [model]);
  return (
    <View style={styles.content}>
      <Text style={styles.muted}>{t("worktreeImport.preserveFiles")}</Text>
      <Button
        variant="ghost"
        size="sm"
        disabled={busy || state.status === "loading"}
        onPress={refresh}
      >
        {t("worktreeImport.refresh")}
      </Button>
      {state.status === "loading" ? <ThemedLoadingSpinner /> : null}
      {state.status === "loaded" && state.worktrees.length === 0 ? (
        <Text style={styles.muted}>{t("worktreeImport.empty")}</Text>
      ) : null}
      {state.status !== "loading" && state.status !== "error"
        ? state.worktrees.map((row) => (
            <WorktreeRow
              key={row.path}
              row={row}
              selected={state.selected.has(row.path)}
              busy={busy}
              onToggle={model.toggle}
              serverId={host.serverId}
              onClose={onClose}
            />
          ))
        : null}
      {state.errors.map((error) => (
        <Text key={error} style={styles.error}>
          {error}
        </Text>
      ))}
      <Button
        variant="default"
        loading={busy}
        disabled={state.status !== "loaded" || state.selected.size === 0}
        onPress={submit}
        testID="import-worktrees-submit"
      >
        {t("worktreeImport.add", { count: state.selected.size })}
      </Button>
    </View>
  );
}

function WorktreeRow({
  row,
  selected,
  busy,
  onToggle,
  serverId,
  onClose,
}: {
  row: ProjectWorktreeCandidate;
  selected: boolean;
  busy: boolean;
  onToggle: (path: string) => void;
  serverId: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const added = Boolean(row.workspaceId && !row.archived);
  const toggle = useCallback(() => onToggle(row.path), [onToggle, row.path]);
  const open = useCallback(() => {
    if (!row.workspaceId) return;
    onClose();
    navigateToWorkspace({ serverId, workspaceId: row.workspaceId });
  }, [onClose, serverId, row.workspaceId]);
  const accessibilityState = useMemo(
    () => ({ checked: added || selected, disabled: busy || row.unavailable || added }),
    [added, selected, busy, row.unavailable],
  );
  return (
    <View style={styles.row}>
      <Pressable
        style={styles.choice}
        accessibilityRole="checkbox"
        aria-checked={added || selected}
        accessibilityLabel={`${row.branch ?? row.head.slice(0, 8)}, ${row.path}`}
        accessibilityState={accessibilityState}
        disabled={accessibilityState.disabled}
        onPress={toggle}
      >
        {added || selected ? <ThemedSquareCheck size={16} /> : <ThemedSquare size={16} />}
        <View style={styles.details}>
          <Text style={styles.text}>
            {row.branch ?? t("worktreeImport.detached", { commit: row.head.slice(0, 8) })}
          </Text>
          <Text style={styles.muted} selectable>
            {row.path}
          </Text>
          {row.unavailable ? (
            <Text style={styles.muted}>{t("worktreeImport.unavailable")}</Text>
          ) : null}
          {row.archived && !row.unavailable ? (
            <Text style={styles.muted}>{t("worktreeImport.restore")}</Text>
          ) : null}
        </View>
      </Pressable>
      {added ? (
        <Button variant="ghost" size="sm" disabled={busy || row.unavailable} onPress={open}>
          {t("worktreeImport.open")}
        </Button>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  content: { gap: theme.spacing[3] },
  row: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  choice: {
    flex: 1,
    flexDirection: "row",
    gap: theme.spacing[3],
    paddingVertical: theme.spacing[2],
  },
  details: { flex: 1, gap: theme.spacing[1] },
  text: { color: theme.colors.foreground, fontSize: theme.fontSize.base },
  muted: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  error: { color: theme.colors.destructive, fontSize: theme.fontSize.sm },
}));
