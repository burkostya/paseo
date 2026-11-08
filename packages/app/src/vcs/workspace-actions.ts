import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { vcsViews } from "./views";
import { v4 as uuid } from "uuid";
import { useHostFeature } from "@/runtime/host-features";
import { useInstalledPlugins } from "@/plugins/registry";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import { useVcsSnapshot, useWorkspaceVcs } from "./queries";
import { resolveVcsContribution, vcsContextActions } from "./contributions";
import { usesProviderVcsUi } from "./selection";

export function useWorkspaceVcsActions(
  serverId: string,
  workspaceId: string,
  open: boolean,
  entryPoint: "workspace" | "command-center" = "workspace",
) {
  const { t } = useTranslation();
  const publication = useHostFeature(serverId, "vcsPublication");
  const workingCopies = useHostFeature(serverId, "vcsWorkingCopySelection");
  const { providerId, connected } = useWorkspaceVcs(serverId, workspaceId);
  const supported = useHostFeature(serverId, "vcsDiffFiles");
  const plugins = useInstalledPlugins();
  const comparisons = useHostFeature(serverId, "vcsBaseComparisons");
  const enabled = open && supported && usesProviderVcsUi(providerId, comparisons);
  const snapshot = useVcsSnapshot(serverId, workspaceId, enabled);
  return useMemo(() => {
    if (!enabled || !connected) return { items: [], views: [], error: null };
    if (snapshot.error) return { items: [], views: [], error: snapshot.error.message };
    if (!snapshot.data) return { items: [], views: [], error: null };
    try {
      const resolved = resolveVcsContribution(plugins, serverId, snapshot.data.binding.providerId);
      if (!resolved) return { items: [], views: [], error: null };
      const items = vcsContextActions(resolved.contribution.actions, {
        workspaceId,
        snapshot: snapshot.data,
        selection: { kind: "workspace" },
        revisions: [],
        files: [],
      }).map(({ action, availability }) => ({
        providerId: resolved.contribution.providerId,
        title: resolved.plugin.i18n.resolve(action.title, resolved.plugin.locale),
        section: resolved.plugin.i18n.resolve(resolved.contribution.title, resolved.plugin.locale),
        icon: action.icon,
        id: availability.id,
        enabled: availability.enabled,
        reason: availability.reason,
      }));
      const views = vcsViews(
        snapshot.data,
        resolved.contribution,
        (value) => resolved.plugin.i18n.resolve(value, resolved.plugin.locale),
        {
          changes: t("vcs.changes"),
          history: t("vcs.history"),
          refs: t("vcs.refs"),
          publish: t("vcs.openPublication"),
          workingCopy: t("vcs.createWorkingCopy"),
        },
      )
        .filter(
          (view) =>
            view.entryPoints?.includes(entryPoint) &&
            (view.id !== "publish" || publication) &&
            (view.id !== "working-copy" || workingCopies),
        )
        .map((view) => ({
          id: view.id,
          title: view.title,
          icon: view.icon,
          providerId: resolved.contribution.providerId,
          section: resolved.plugin.i18n.resolve(
            resolved.contribution.title,
            resolved.plugin.locale,
          ),
          enabled: true,
          reason: undefined,
        }));
      return { items, views, error: null };
    } catch (error) {
      return {
        items: [],
        views: [],
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }, [
    enabled,
    connected,
    snapshot.data,
    snapshot.error,
    plugins,
    serverId,
    workspaceId,
    entryPoint,
    publication,
    workingCopies,
    t,
  ]);
}

export function openWorkspaceVcsView(input: {
  serverId: string;
  workspaceId: string;
  providerId: string;
  view: string;
}) {
  navigateToWorkspace({
    serverId: input.serverId,
    workspaceId: input.workspaceId,
    target: {
      kind: "working_diff",
      vcsView: { providerId: input.providerId, view: input.view, requestId: uuid() },
    },
  });
}

export function openWorkspaceVcsAction(input: {
  serverId: string;
  workspaceId: string;
  providerId: string;
  actionId: string;
}) {
  navigateToWorkspace({
    serverId: input.serverId,
    workspaceId: input.workspaceId,
    target: {
      kind: "working_diff",
      vcsAction: { providerId: input.providerId, actionId: input.actionId, requestId: uuid() },
    },
  });
}
