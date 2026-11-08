import { useCallback, useMemo } from "react";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import type { VcsData, VcsSnapshot } from "@getpaseo/protocol/vcs";
import { useInstalledPlugins } from "@/plugins/registry";
import { resolveVcsContribution } from "./contributions";
import { VcsPluginSurface } from "./plugin-surface";

export function useWorkingCopyValidator(serverId: string, snapshot: VcsSnapshot | null) {
  const plugins = useInstalledPlugins();
  return useCallback(
    (revision: string, value: VcsData | undefined) => {
      if (!snapshot) return null;
      const resolved = resolveVcsContribution(plugins, serverId, snapshot.binding.providerId);
      return resolved?.contribution.workingCopy?.validate?.({ snapshot, revision }, value) ?? null;
    },
    [plugins, serverId, snapshot],
  );
}

export function VcsWorkingCopyFields({
  serverId,
  snapshot,
  revision,
  value,
  disabled,
  onChange,
}: {
  serverId: string;
  snapshot: VcsSnapshot;
  revision: string;
  value: VcsData | undefined;
  disabled: boolean;
  onChange(value: VcsData | undefined): void;
}) {
  const plugins = useInstalledPlugins();
  const resolved = resolveVcsContribution(plugins, serverId, snapshot.binding.providerId);
  const Form = resolved?.contribution.workingCopy?.Form;
  const context = useMemo(() => ({ snapshot, revision }), [snapshot, revision]);
  const change = useCallback(
    (data: VcsData | undefined) => {
      if (!disabled) onChange(data);
    },
    [disabled, onChange],
  );
  const render = useCallback(
    (surface: PluginSurfaceProps) =>
      Form ? (
        <Form {...surface} context={context} value={value} disabled={disabled} onChange={change} />
      ) : null,
    [Form, context, value, disabled, change],
  );
  if (!resolved || !Form) return null;
  return <VcsPluginSurface plugin={resolved.plugin}>{render}</VcsPluginSurface>;
}
