import type { ProviderUsageAlert } from "@getpaseo/protocol/messages";
import { useReplicaQuery } from "@/data/query";
import { useHostFeature } from "@/runtime/host-features";

export function providerUsageAlertsQueryKey(serverId: string) {
  return ["providerUsageAlerts", serverId] as const;
}

export function useProviderUsageAlerts(serverId: string): ProviderUsageAlert[] {
  const supported = useHostFeature(serverId, "providerUsageWarnings");
  const query = useReplicaQuery<ProviderUsageAlert[]>({
    queryKey: providerUsageAlertsQueryKey(serverId),
    enabled: false,
    pushEvent: "status:provider.usage.alerts.changed",
  });
  return supported ? (query.data ?? []) : [];
}

export type { ProviderUsageAlert };
