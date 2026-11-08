import type {
  PluginVcsContext,
  PluginVcsActionContribution,
  PluginText,
} from "@getpaseo/plugin/client";
import type { InstalledPlugin } from "@/plugins/types";

export function resolveVcsContribution(
  plugins: readonly InstalledPlugin[],
  serverId: string,
  providerId: string,
) {
  const matches = plugins
    .filter((plugin) => plugin.serverId === serverId)
    .flatMap((plugin) =>
      plugin.vcsContributions
        .filter((contribution) => contribution.providerId === providerId)
        .map((contribution) => ({ plugin, contribution })),
    );
  if (matches.length > 1)
    throw new Error(`Multiple client contributions for VCS provider ${providerId}`);
  return matches.at(0) ?? null;
}
export function vcsContextActions(
  actions: readonly PluginVcsActionContribution<PluginText>[],
  context: PluginVcsContext,
) {
  return actions.flatMap((action) => {
    const availability = context.snapshot.actions.find((candidate) => candidate.id === action.id);
    return availability && action.contexts.includes(context.selection.kind)
      ? [{ action, availability }]
      : [];
  });
}
