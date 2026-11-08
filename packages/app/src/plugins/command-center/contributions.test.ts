import { PluginTranslationRuntime } from "@getpaseo/plugin/client/host";
import { QueryClient } from "@tanstack/react-query";
import { createPaseoApi, type PaseoApi } from "@getpaseo/client";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import {
  defineRpc,
  type PluginAgentSnapshot,
  type PluginWorkspaceSnapshot,
} from "@getpaseo/plugin";
import { type PluginCommandCenterItemContribution } from "@getpaseo/plugin/client";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { InstalledPlugin } from "../types";
import {
  buildPluginCommandCenterContributions,
  buildVcsCommandCenterContributions,
} from "./contributions";

const workspace: PluginWorkspaceSnapshot = {
  id: "workspace-1",
  projectId: "project-1",
  projectDisplayName: "Paseo",
  projectRootPath: "/repo/paseo",
  directory: "/repo/paseo/review",
  projectKind: "git",
  kind: "worktree",
  name: "Review",
  title: null,
  status: "running",
  statusEnteredAt: null,
  archivingAt: null,
  diffStat: null,
};

const agent: PluginAgentSnapshot = {
  id: "agent-1",
  workspaceId: workspace.id,
  provider: "codex",
  status: "running",
  createdAt: "2026-08-16T10:00:00.000Z",
  updatedAt: "2026-08-16T10:00:00.000Z",
  lastActivityAt: "2026-08-16T10:00:00.000Z",
  title: "Review",
  cwd: workspace.directory,
  model: "gpt-5.6",
  currentModeId: null,
  thinkingOptionId: null,
  requiresAttention: false,
  attentionReason: null,
  parentAgentId: null,
  labels: {},
};

const inspect = defineRpc({
  name: "review.inspect",
  input: z.object({ value: z.number() }),
  output: z.object({ value: z.number() }),
});

type AgentCommandItem = Extract<PluginCommandCenterItemContribution, { context: "agent" }>;

function plugin(onAgentSelect: AgentCommandItem["onSelect"]): InstalledPlugin {
  return {
    id: "review",
    serverId: "host-1",
    clientBundle: "bundle",
    lifetime: new AbortController(),
    locale: "en",
    i18n: new PluginTranslationRuntime({ getLocale: () => "en", subscribe: () => () => {} }),
    paseo: createPaseoApi(
      new DaemonClient({
        url: "ws://127.0.0.1:1",
        clientId: "plugin-command-test",
        clientType: "cli",
      }),
    ),
    invoke: async (method: string, input: unknown) => {
      expect(method).toBe("review.inspect");
      return { value: inspect.input.parse(input).value + 1 };
    },
    queryClient: new QueryClient(),
    cleanup: () => {},
    settingsScreens: [],
    surfaces: [{ id: "main", title: "Main", Component: () => null }],
    sidebarItems: { header: [], footer: [] },
    legacySidebarItems: [],
    filePanels: [],
    vcsContributions: [],
    workspacePanels: [
      {
        id: "details",
        title: "Details",
        icon: "Scan",
        context: "agent",
        locations: ["workspace", "explorer"],
        Component: () => null,
      },
    ],
    commandCenterItems: [
      {
        id: "global",
        title: "Global review",
        icon: "Scan",
        context: "global",
        onSelect: () => {},
      },
      {
        id: "workspace",
        title: "Workspace review",
        icon: "Scan",
        context: "workspace",
        onSelect: () => {},
      },
      {
        id: "agent",
        title: "Agent review",
        icon: "Scan",
        context: "agent",
        onSelect: onAgentSelect,
      },
    ],
    clientSlashCommands: [],
    attachmentSources: [],
    themes: [],
    timelineTransformers: [],
    timelineRenderers: [],
  };
}

function stateSource() {
  return {
    subscribe() {
      return () => {};
    },
    getWorkspace(id: string) {
      return id === workspace.id ? workspace : null;
    },
    getAgent(id: string) {
      return id === agent.id ? agent : null;
    },
  };
}

describe("plugin Command Center contributions", () => {
  it("shows only contributions whose synchronous context exists", () => {
    const installed = plugin(() => undefined);
    const common = {
      plugins: [installed],
      state: stateSource(),
      navigation: {
        openSettings() {},
        openSurface() {},
        openWorkspacePanel() {},
        openAgentPanel() {},
      },
      reportError() {},
    };

    expect(
      buildPluginCommandCenterContributions({
        ...common,
        workspaceId: null,
        agentId: null,
      }).map((item) => item.id),
    ).toEqual(["review:global"]);
    expect(
      buildPluginCommandCenterContributions({
        ...common,
        workspaceId: workspace.id,
        agentId: null,
      }).map((item) => item.id),
    ).toEqual(["review:global", "review:workspace"]);
    expect(
      buildPluginCommandCenterContributions({
        ...common,
        workspaceId: workspace.id,
        agentId: agent.id,
      }).map((item) => item.id),
    ).toEqual(["review:global", "review:workspace", "review:agent"]);
  });

  it("supplies the direct API, typed RPC, snapshots, and narrow navigation", async () => {
    const opened: string[] = [];
    let rpcValue = 0;
    let receivedPaseo: PaseoApi | null = null;
    const installed = plugin(async (context) => {
      expect(context.workspace).toBe(workspace);
      expect(context.agent).toBe(agent);
      receivedPaseo = context.paseo;
      rpcValue = (await context.rpc(inspect, { value: 4 })).value;
      context.openSurface("main");
      context.openPanel("details", { location: "explorer" });
    });
    const actions = buildPluginCommandCenterContributions({
      plugins: [installed],
      state: stateSource(),
      workspaceId: workspace.id,
      agentId: agent.id,
      navigation: {
        openSettings() {},
        openSurface(pluginId, surfaceId) {
          opened.push(`${pluginId}/surface/${surfaceId}`);
        },
        openWorkspacePanel(pluginId, panelId, location) {
          opened.push(`${pluginId}/workspace/${panelId}/${location}`);
        },
        openAgentPanel(pluginId, panelId, agentId, location) {
          opened.push(`${pluginId}/agent/${panelId}/${agentId}/${location}`);
        },
      },
      reportError(error) {
        throw error;
      },
    });

    await actions.find((action) => action.id === "review:agent")?.run();

    expect(rpcValue).toBe(5);
    // Commands use the plugin's one client.
    expect(receivedPaseo).toBe(installed.paseo);
    expect(opened).toEqual(["review/surface/main", "review/agent/details/agent-1/explorer"]);
  });

  it("removes every contribution when its installation disappears", () => {
    expect(
      buildPluginCommandCenterContributions({
        plugins: [],
        state: stateSource(),
        workspaceId: workspace.id,
        agentId: agent.id,
        navigation: {
          openSettings() {},
          openSurface() {},
          openWorkspacePanel() {},
          openAgentPanel() {},
        },
        reportError() {},
      }),
    ).toEqual([]);
  });
});

describe("VCS workspace commands", () => {
  it("uses provider action IDs and reports blocked actions without launching them", () => {
    const open = vi.fn();
    const reportUnavailable = vi.fn();
    const contributions = buildVcsCommandCenterContributions({
      open,
      openView: vi.fn(),
      views: [],
      reportUnavailable,
      items: [
        {
          id: "change.describe",
          providerId: "external",
          title: "Describe",
          section: "External VCS",
          enabled: true,
          reason: undefined,
          icon: undefined,
        },
        {
          id: "edit",
          providerId: "external",
          title: "Edit",
          section: "External VCS",
          enabled: false,
          reason: "Workspace is stale",
          icon: undefined,
        },
      ],
    });
    expect(contributions.map((item) => item.id)).toEqual([
      "vcs:external:change.describe",
      "vcs:external:edit",
    ]);
    expect(contributions[1].presentation).toMatchObject({ subtitle: "Workspace is stale" });
    contributions[0].run();
    contributions[1].run();
    expect(open.mock.calls).toEqual([["external", "change.describe"]]);
    expect(reportUnavailable.mock.calls).toEqual([["Workspace is stale"]]);
    expect(
      buildVcsCommandCenterContributions({
        open,
        reportUnavailable,
        items: [],
        views: [],
        openView: vi.fn(),
      }),
    ).toEqual([]);
  });
  it("opens VCS views without invoking actions with the same ID", () => {
    const open = vi.fn();
    const openView = vi.fn();
    const item = {
      id: "publish",
      providerId: "external",
      title: "Publish",
      section: "External",
      icon: undefined,
      enabled: true,
      reason: undefined,
    };
    const contributions = buildVcsCommandCenterContributions({
      items: [item],
      views: [item],
      open,
      openView,
      reportUnavailable: vi.fn(),
    });
    expect(contributions.map((entry) => entry.id)).toEqual([
      "vcs:external:publish",
      "vcs-view:external:publish",
    ]);
    contributions[1].run();
    expect(openView).toHaveBeenCalledWith("external", "publish");
    expect(open).not.toHaveBeenCalled();
  });
});
