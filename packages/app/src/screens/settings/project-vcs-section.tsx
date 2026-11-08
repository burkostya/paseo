import { useFetchQuery } from "@/data/query";
import { useCallback, useMemo } from "react";
import { Text } from "react-native";
import { useFocusEffect } from "expo-router/react-navigation";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { SettingsCard, SettingsRow, SettingsSection, SettingsSelect } from "@/components/settings";
import { Button } from "@/components/ui/button";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { settingsStyles } from "@/styles/settings";

interface Props {
  client: DaemonClient;
  serverId: string;
  projectId: string;
}

export function ProjectVcsSection(props: Props) {
  const supported = useHostFeature(props.serverId, "vcsProviders");
  if (!supported) return null;
  return <ProjectVcsSettings key={`${props.serverId}:${props.projectId}`} {...props} />;
}

/** One immediately persisted choice; query state remains authoritative until the host confirms it. */
function ProjectVcsSettings({ client, serverId, projectId }: Props) {
  const { t } = useTranslation();
  const connected = useHostRuntimeIsConnected(serverId);
  const cache = useQueryClient();
  const queryKey = useMemo(
    () => ["project-vcs", serverId, projectId] as const,
    [serverId, projectId],
  );
  const query = useFetchQuery({
    dataShape: "value",
    staleTimeMs: 30_000,
    queryKey,
    enabled: connected,
    retry: false,
    queryFn: async () => {
      const [selection, providers] = await Promise.all([
        client.requestVcs({ type: "vcs.project.get.request", projectId }),
        client.requestVcs({ type: "vcs.providers.list.request" }),
      ]);
      return { selection, providers };
    },
  });
  const refetch = query.refetch;
  useFocusEffect(
    useCallback(() => {
      if (connected) void refetch();
    }, [connected, refetch]),
  );
  const save = useMutation({
    mutationFn: (providerId: string) =>
      client.requestVcs({ type: "vcs.project.select.request", projectId, providerId }),
    onSuccess: (selection) => {
      cache.setQueryData<typeof query.data>(queryKey, (current) =>
        current ? { ...current, selection } : current,
      );
    },
    // Re-read after a failure too: a lost acknowledgement does not prove the host kept the old choice.
    onSettled: () => cache.invalidateQueries({ queryKey }),
  });
  const choose = useCallback(
    (providerId: string) => {
      if (
        !providerId ||
        !connected ||
        save.isPending ||
        providerId === query.data?.selection.providerId
      )
        return;
      save.mutate(providerId);
    },
    [connected, query.data?.selection.providerId, save],
  );
  const reload = useCallback(() => {
    void refetch();
  }, [refetch]);
  const selectedId = query.data?.selection.providerId ?? "";
  const options = useMemo(() => {
    const providers = query.data?.providers ?? [];
    const counts = new Map<string, number>();
    for (const provider of providers) counts.set(provider.id, (counts.get(provider.id) ?? 0) + 1);
    const choices = providers
      .filter((provider) => counts.get(provider.id) === 1)
      .map((provider) => ({ value: provider.id, label: provider.label }));
    if (!selectedId) choices.unshift({ value: "", label: t("settings.project.vcs.none") });
    else if (!choices.some((option) => option.value === selectedId))
      choices.unshift({
        value: selectedId,
        label: t("settings.project.vcs.unavailable", { provider: selectedId }),
      });
    if (save.isPending) {
      const selected = choices.find((option) => option.value === selectedId);
      if (selected) selected.label = t("settings.project.vcs.saving");
    }
    return choices;
  }, [query.data?.providers, selectedId, save.isPending, t]);
  const error = save.error ?? query.error;
  const errorText = error instanceof Error ? error.message : undefined;
  let control;
  if (!query.data) {
    control = (
      <SettingsRow label={t("settings.project.vcs.provider")} error={errorText}>
        {query.isError ? (
          <Button
            variant="outline"
            disabled={!connected}
            onPress={reload}
            testID="project-vcs-retry"
          >
            {t("settings.project.vcs.retry")}
          </Button>
        ) : (
          <Text style={settingsStyles.rowHint}>
            {connected ? t("settings.project.vcs.loading") : t("settings.project.vcs.offline")}
          </Text>
        )}
      </SettingsRow>
    );
  } else {
    control = (
      <SettingsSelect
        testID="project-vcs-provider"
        label={t("settings.project.vcs.provider")}
        value={selectedId}
        options={options}
        onValueChange={choose}
        disabled={!connected || save.isPending}
        error={errorText}
      />
    );
  }
  return (
    <SettingsSection title={t("settings.project.vcs.title")} testID="project-vcs-settings">
      <SettingsCard>{control}</SettingsCard>
    </SettingsSection>
  );
}
