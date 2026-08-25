import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { IssueTrackerConfig } from "@getpaseo/protocol/issue-trackers";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { useHostFeature } from "@/runtime/host-features";

const EMPTY_ISSUE_TRACKERS: readonly IssueTrackerConfig[] = [];
const IssueTrackersContext = createContext<readonly IssueTrackerConfig[]>(EMPTY_ISSUE_TRACKERS);

export function useHostIssueTrackers(serverId: string | null | undefined): {
  supported: boolean;
  trackers: readonly IssueTrackerConfig[];
  isLoading: boolean;
} {
  const supported = useHostFeature(serverId, "issueLinks");
  const { config, isLoading } = useDaemonConfig(supported ? (serverId ?? null) : null);
  const trackers = useMemo(
    () => (supported ? (config?.issueTrackers ?? EMPTY_ISSUE_TRACKERS) : EMPTY_ISSUE_TRACKERS),
    [config?.issueTrackers, supported],
  );
  return { supported, trackers, isLoading: supported && isLoading };
}

export function IssueTrackersProvider({
  serverId,
  children,
}: {
  serverId: string;
  children: ReactNode;
}) {
  const { trackers } = useHostIssueTrackers(serverId);
  return <IssueTrackersContext.Provider value={trackers}>{children}</IssueTrackersContext.Provider>;
}

export function useIssueTrackers(): readonly IssueTrackerConfig[] {
  return useContext(IssueTrackersContext);
}
