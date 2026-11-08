import type { DaemonClient } from "../daemon-client.js";
import type { VcsData } from "@getpaseo/protocol/vcs";
import type { VcsComparisonTarget, VcsComparisonSettings } from "@getpaseo/protocol/vcs-rpc";
export interface PaseoVcsComparisonSettings {
  get(providerId: string): Promise<VcsComparisonSettings>;
  set(providerId: string, value: VcsData | null): Promise<VcsComparisonSettings>;
}
export function createComparisonSettings(
  client: DaemonClient,
  target: VcsComparisonTarget,
): PaseoVcsComparisonSettings {
  return {
    get: (providerId) =>
      client.requestVcs({ type: "vcs.comparison.get.request", target, providerId }),
    set: (providerId, value) =>
      client.requestVcs({ type: "vcs.comparison.set.request", target, providerId, value }),
  };
}
