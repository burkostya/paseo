import { useCallback, useEffect, useId, useMemo, useState, useSyncExternalStore } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { createPaseoApi, type PaseoVcsComparisonSettings } from "@getpaseo/client";
import type { VcsComparisonSettings } from "@getpaseo/protocol/vcs-rpc";
import type { VcsSnapshot } from "@getpaseo/protocol/vcs";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useFetchQuery } from "@/data/query";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { useWorkspace } from "@/stores/session-store-hooks";
import { useInstalledPlugins } from "@/plugins/registry";
import { Button } from "@/components/ui/button";
import { SelectField } from "@/components/ui/select-field";
import { resolveVcsContribution } from "./contributions";
import { VcsPluginSurface } from "./plugin-surface";
import { useVcsSnapshot } from "./queries";
import { GitComparisonSettings } from "./git-comparison-settings";
import { openComparisonSettings } from "./comparison-settings-model";
import { vcsStyles as styles } from "./styles";

interface Props {
  serverId: string;
  workspaceId: string;
}
export function ComparisonSettings(props: Props) {
  const supported = useHostFeature(props.serverId, "vcsComparisonSettings");
  // COMPAT(vcsComparisonSettings): v0.15.2; remove after 2027-06-06 when older hosts expire.
  return supported ? <Settings {...props} /> : <GitComparisonSettings {...props} />;
}
function Settings(props: Props) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const toggle = useCallback(() => setOpen((value) => !value), []);
  return (
    <View style={styles.notice}>
      <Button variant="outline" onPress={toggle} testID="vcs-comparison-settings">
        {t(open ? "vcs.comparisonClose" : "vcs.comparisonSettings")}
      </Button>
      {open && <SettingsScope key={`${props.serverId}:${props.workspaceId}`} {...props} />}
    </View>
  );
}
function SettingsScope(props: Props) {
  const { t } = useTranslation();
  const [scope, setScope] = useState("workspace");
  const options = useMemo(
    () => [
      { id: "workspace", value: "workspace", label: t("vcs.comparisonWorkspace") },
      { id: "project", value: "project", label: t("vcs.comparisonProject") },
    ],
    [t],
  );
  return (
    <>
      <SelectField
        placeholder={t("vcs.comparisonSettings")}
        emptyText={t("vcs.noRefs")}
        label={t("vcs.comparisonSettings")}
        value={scope}
        selectedDisplay={options.find((option) => option.value === scope)!}
        options={options}
        onChange={setScope}
        testID="vcs-comparison-settings-scope"
      />
      <SettingsLoader key={scope} {...props} scope={scope} />
    </>
  );
}
function SettingsLoader({ serverId, workspaceId, scope }: Props & { scope: string }) {
  const { t } = useTranslation();
  const workspace = useWorkspace(serverId, workspaceId);
  const client = useHostRuntimeClient(serverId);
  const snapshot = useVcsSnapshot(serverId, workspaceId, true);
  const projectId = workspace?.projectId;
  const api = useMemo(() => {
    if (!client || !projectId) return null;
    const paseo = createPaseoApi(client);
    return scope === "project"
      ? paseo.projects.vcs.comparison(projectId)
      : paseo.workspaces.ref(workspaceId).vcs.comparison;
  }, [client, scope, projectId, workspaceId]);
  const providerId = workspace?.vcsProviderId;
  const formId = useId();
  const settings = useFetchQuery({
    dataShape: "value",
    staleTimeMs: 0,
    queryKey: ["vcs-comparison-settings", serverId, workspaceId, scope, providerId, formId],
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
    enabled: !!api && !!providerId,
    retry: false,
    queryFn: () => api!.get(providerId!),
  });
  const plugins = useInstalledPlugins();
  const resolved = providerId ? resolveVcsContribution(plugins, serverId, providerId) : null;
  if (settings.error || snapshot.error)
    return <Text style={styles.error}>{settings.error?.message ?? snapshot.error?.message}</Text>;
  if (!settings.data || !snapshot.data || !api || settings.isFetching)
    return <Text style={styles.muted}>{t("vcs.loading")}</Text>;
  if (!resolved?.contribution.ComparisonSettings)
    return <Text style={styles.muted}>{t("vcs.pluginChanged")}</Text>;
  return (
    <SettingsForm
      key={providerId}
      settings={settings.data}
      api={api}
      snapshot={snapshot.data}
      resolved={resolved}
    />
  );
}
function SettingsForm({
  settings,
  api,
  snapshot,
  resolved,
}: {
  settings: VcsComparisonSettings;
  api: PaseoVcsComparisonSettings;
  snapshot: VcsSnapshot;
  resolved: NonNullable<ReturnType<typeof resolveVcsContribution>>;
}) {
  const { t } = useTranslation();
  const [model] = useState(() =>
    openComparisonSettings({ settings, save: (value) => api.set(settings.providerId, value) }),
  );
  useEffect(() => {
    model.activate();
    return model.close;
  }, [model]);
  const state = useSyncExternalStore(model.subscribe, model.getState, model.getState);
  const Form = resolved.contribution.ComparisonSettings!;
  const render = useCallback(
    (surface: PluginSurfaceProps) => (
      <Form
        {...surface}
        snapshot={snapshot}
        value={state.value}
        onChange={model.change}
        disabled={state.pending}
      />
    ),
    [Form, snapshot, state.value, state.pending, model],
  );
  const save = useCallback(() => void model.save(), [model]);
  const reset = useCallback(() => void model.save(true), [model]);
  return (
    <View style={styles.form}>
      <VcsPluginSurface plugin={resolved.plugin}>{render}</VcsPluginSurface>
      {state.error && <Text style={styles.error}>{state.error}</Text>}
      {state.saved && <Text style={styles.muted}>{t("vcs.comparisonSaved")}</Text>}
      <View style={styles.actions}>
        <Button onPress={save} disabled={state.pending} testID="vcs-comparison-settings-save">
          {t("vcs.comparisonSave")}
        </Button>
        <Button
          variant="outline"
          onPress={reset}
          disabled={state.pending}
          testID="vcs-comparison-settings-reset"
        >
          {t("vcs.comparisonReset")}
        </Button>
      </View>
    </View>
  );
}
