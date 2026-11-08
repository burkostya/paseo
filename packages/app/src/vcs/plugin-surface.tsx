import { useMemo, type ReactNode } from "react";
import { withUnistyles } from "react-native-unistyles";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { PluginClientStateProvider } from "@getpaseo/plugin/client/host";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useHosts } from "@/runtime/host-runtime";
import { usePluginHostNavigation } from "@/plugins/host-navigation";
import { createPluginClientStateSource } from "@/plugins/client-state/source";
import { PluginInstallationProvider } from "@/plugins/installation-provider";
import { SurfaceErrorBoundary } from "@/plugins/surface-error-boundary";
import { resolvePluginPlatform } from "@/plugins/platform";
import { toPluginTheme } from "@/plugins/theme";
import type { InstalledPlugin } from "@/plugins/types";
import type { PluginTheme } from "@getpaseo/plugin";

function Surface({
  plugin,
  theme,
  children,
}: {
  plugin: InstalledPlugin;
  theme: PluginTheme;
  children(props: PluginSurfaceProps): ReactNode;
}) {
  const compact = useIsCompactFormFactor();
  const hosts = useHosts();
  const label = hosts.find((host) => host.serverId === plugin.serverId)?.label ?? plugin.serverId;
  const source = useMemo(() => createPluginClientStateSource(plugin.serverId), [plugin.serverId]);
  const navigation = usePluginHostNavigation(plugin.serverId);
  return (
    <SurfaceErrorBoundary installation={plugin} Surface={children}>
      <PluginInstallationProvider plugin={plugin}>
        <PluginClientStateProvider source={source}>
          {children({
            theme,
            host: { id: plugin.serverId, label },
            layout: { compact, platform: resolvePluginPlatform() },
            navigation,
          })}
        </PluginClientStateProvider>
      </PluginInstallationProvider>
    </SurfaceErrorBoundary>
  );
}
export const VcsPluginSurface = withUnistyles(Surface, (theme) => ({
  theme: toPluginTheme(theme),
}));
