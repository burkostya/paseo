import type { PluginIcon, PluginText, PluginVcsContribution } from "@getpaseo/plugin/client";
import type { VcsSnapshot } from "@getpaseo/protocol/vcs";
import type { VcsPaneState, VcsViewRequest } from "./state";

export function vcsViews(
  snapshot: VcsSnapshot,
  contribution: PluginVcsContribution<PluginText> | undefined,
  text: (value: PluginText) => string,
  labels: { changes: string; history: string; refs: string; publish: string; workingCopy: string },
) {
  const views: { id: string; title: string; icon?: PluginIcon; entryPoints?: readonly string[] }[] =
    [
      { id: "changes", title: labels.changes },
      ...(snapshot.capabilities.includes("history")
        ? [{ id: "history", title: labels.history }]
        : []),
      { id: "refs", title: labels.refs },
    ];
  if (snapshot.capabilities.includes("publication"))
    views.push({
      id: "publish",
      title: labels.publish,
      icon: "GitPullRequest",
      entryPoints: ["workspace", "command-center"],
    });
  for (const panel of contribution?.panels ?? [])
    views.push({
      id: `plugin:${panel.id}`,
      title: text(panel.title),
      icon: panel.icon,
      entryPoints: panel.entryPoints,
    });
  if (snapshot.capabilities.includes("working-copies"))
    views.push({
      id: "working-copy",
      title: labels.workingCopy,
      icon: "CopyPlus",
      entryPoints: ["workspace", "command-center"],
    });
  return views;
}

export function applyViewRequest(
  state: VcsPaneState,
  request: VcsViewRequest | undefined,
  providerId: string,
  available: readonly { id: string }[],
) {
  if (!request || request.requestId === state.consumedViewRequestId)
    return { state, unavailable: false };
  const consumed = { ...state, consumedViewRequestId: request.requestId };
  if (request.providerId !== providerId || !available.some((view) => view.id === request.view))
    return { state: consumed, unavailable: true };
  return {
    state: {
      ...consumed,
      providerId,
      view: request.view,
      selection: { kind: "workspace" as const },
    },
    unavailable: false,
  };
}

export function availableVcsView(snapshot: VcsSnapshot | undefined, view: string): string {
  return snapshot && view === "history" && !snapshot.capabilities.includes("history")
    ? "changes"
    : view;
}
