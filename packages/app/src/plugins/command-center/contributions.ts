import type { PluginClientStateSource } from "@getpaseo/plugin/client/host";
import type { CommandCenterContribution } from "@/command-center/contributions";
import { getCommandCenterIcon } from "@/command-center/icon";
import { pluginIconComponent } from "../icons";
import { resolvePluginPanelOpenLocation } from "../workspace-panels/locations";
import type { InstalledPlugin } from "../types";
import { createPluginCapabilities, type PluginNavigation } from "../actions";

export interface PluginCommandCenterSource {
  plugins: readonly InstalledPlugin[];
  state: PluginClientStateSource;
  workspaceId: string | null;
  agentId: string | null;
  navigation: PluginNavigation;
  reportError(error: unknown): void;
}

export function buildVcsCommandCenterContributions(input: {
  items: ReturnType<typeof import("@/vcs/workspace-actions").useWorkspaceVcsActions>["items"];
  views: ReturnType<typeof import("@/vcs/workspace-actions").useWorkspaceVcsActions>["views"];
  openView(providerId: string, view: string): void;
  open(providerId: string, actionId: string): void;
  reportUnavailable(reason?: string): void;
}): CommandCenterContribution[] {
  return [
    ...input.items.map((item) => ({ ...item, view: false })),
    ...input.views.map((item) => ({ ...item, view: true })),
  ].map((item, rank) => ({
    id: `${item.view ? "vcs-view" : "vcs"}:${item.providerId}:${item.id}`,
    group: `vcs:${item.providerId}`,
    groupRank: 0,
    rank,
    keywords: ["vcs", item.providerId, item.id],
    visibility: "query",
    presentation: {
      kind: "action",
      title: item.title,
      sectionTitle: item.section,
      subtitle: item.reason,
      icon: item.icon ? getCommandCenterIcon(pluginIconComponent(item.icon)) : undefined,
    },
    run() {
      if (!item.enabled) return input.reportUnavailable(item.reason);
      if (item.view) return input.openView(item.providerId, item.id);
      input.open(item.providerId, item.id);
    },
  }));
}

export function buildPluginCommandCenterContributions(
  source: PluginCommandCenterSource,
): CommandCenterContribution[] {
  const contributions: CommandCenterContribution[] = [];
  for (const plugin of source.plugins) {
    for (const [rank, item] of plugin.commandCenterItems.entries()) {
      if (item.context === "workspace" && !source.workspaceId) continue;
      if (item.context === "agent" && (!source.workspaceId || !source.agentId)) continue;
      const run = async () => {
        const common = createPluginCapabilities(plugin, source.navigation);
        try {
          if (item.context === "global") {
            await item.onSelect({ context: "global", ...common });
            return;
          }
          const workspace = source.workspaceId
            ? source.state.getWorkspace(source.workspaceId)
            : null;
          if (!workspace) return;
          if (item.context === "workspace") {
            await item.onSelect({
              context: "workspace",
              ...common,
              workspace,
              openPanel(panelId, options) {
                const panel = plugin.workspacePanels.find(
                  (candidate) => candidate.id === panelId && candidate.context === "workspace",
                );
                if (!panel) throw new Error(`Workspace panel is unavailable: ${panelId}`);
                const location = resolvePluginPanelOpenLocation(panel, options?.location);
                source.navigation.openWorkspacePanel(plugin.id, panelId, location);
              },
            });
            return;
          }
          const agent = source.agentId ? source.state.getAgent(source.agentId) : null;
          if (!agent) return;
          await item.onSelect({
            context: "agent",
            ...common,
            workspace,
            agent,
            openPanel(panelId, options) {
              const panel = plugin.workspacePanels.find((candidate) => candidate.id === panelId);
              if (!panel) throw new Error(`Workspace panel is unavailable: ${panelId}`);
              const location = resolvePluginPanelOpenLocation(panel, options?.location);
              if (panel.context === "workspace") {
                source.navigation.openWorkspacePanel(plugin.id, panelId, location);
                return;
              }
              source.navigation.openAgentPanel(plugin.id, panelId, agent.id, location);
            },
          });
        } catch (error) {
          source.reportError(error);
        }
      };
      contributions.push({
        id: `${plugin.id}:${item.id}`,
        group: `plugin:${plugin.id}`,
        groupRank: 5,
        rank,
        keywords: item.keywords ?? [],
        visibility: "always",
        presentation: {
          kind: "action",
          title: plugin.i18n.resolve(item.title, plugin.locale),
          sectionTitle: plugin.id,
          icon: getCommandCenterIcon(pluginIconComponent(item.icon)),
        },
        run,
      });
    }
  }
  return contributions;
}
