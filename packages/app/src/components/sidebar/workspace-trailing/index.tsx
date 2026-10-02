import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { comparisonLabel } from "@/git/comparison/label";
import { useIsCompactFormFactor } from "@/constants/layout";
import { openWorkspaceChanges } from "@/workspace-tabs/open-supporting-view";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import { useSettings } from "@/hooks/use-settings";
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, Text } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { DiffStat } from "@/components/diff-stat";
import type { SidebarWorkspaceEntry } from "@/hooks/use-sidebar-workspaces-list";
import { useAppSettings } from "@/hooks/use-settings";
import type { SidebarWorkspaceTrailing } from "@/hooks/use-settings";
import { useCompactTimeAgo } from "@/hooks/use-time-ago";

export type { SidebarWorkspaceTrailing };

/**
 * The slot to the right of a workspace title. Three renderers behind one preference, so
 * every row renderer asks the same question and the kebab overlay geometry stays identical
 * no matter which one is showing.
 *
 * "none" exists because the slot is the only thing competing with the title for width, and
 * a user who never reads the diff would rather have the characters.
 */
export function useSidebarWorkspaceTrailing(): SidebarWorkspaceTrailing {
  const {
    settings: { sidebarWorkspaceTrailing },
  } = useAppSettings();
  return sidebarWorkspaceTrailing;
}

/** Whether the slot has anything to draw for this workspace under the current preference. */
export function hasSidebarWorkspaceTrailing({
  workspace,
  trailing,
}: {
  workspace: SidebarWorkspaceEntry;
  trailing: SidebarWorkspaceTrailing;
}): boolean {
  if (trailing === "diff")
    return workspace.diffStat !== null || Boolean(workspace.diffComparisonError);
  if (trailing === "timestamp") return workspace.statusEnteredAt !== null;
  return false;
}

export function SidebarWorkspaceTrailingContent({
  workspace,
  trailing,
}: {
  workspace: SidebarWorkspaceEntry;
  trailing: SidebarWorkspaceTrailing;
}) {
  if (trailing === "diff" && (workspace.diffStat || workspace.diffComparisonError)) {
    return <WorkspaceComparisonStat workspace={workspace} />;
  }
  if (trailing === "timestamp" && workspace.statusEnteredAt) {
    return <WorkspaceTimestamp enteredAt={workspace.statusEnteredAt} />;
  }
  return null;
}

function WorkspaceComparisonStat({ workspace }: { workspace: SidebarWorkspaceEntry }) {
  const { t } = useTranslation();
  const isCompact = useIsCompactFormFactor();
  const preferences = useSettings((settings) => settings.openInSidePane);
  const open = useCallback(
    (event: import("react-native").GestureResponderEvent) => {
      event.stopPropagation();
      navigateToWorkspace({ serverId: workspace.serverId, workspaceId: workspace.workspaceId });
      openWorkspaceChanges({
        isCompact,
        workspaceKey: workspace.workspaceKey,
        checkout: { serverId: workspace.serverId, cwd: workspace.workspaceDirectory, isGit: true },
        preferences,
      });
    },
    [isCompact, preferences, workspace],
  );
  const label = comparisonLabel(workspace.diffComparison, t);
  const description = workspace.diffComparisonError
    ? `${t("diffComparison.unavailable")}: ${label}`
    : label;
  return (
    <Tooltip enabledOnDesktop enabledOnMobile={false}>
      <TooltipTrigger asChild>
        <Pressable
          onPress={open}
          accessibilityRole="button"
          accessibilityLabel={description}
          testID={`workspace-comparison-stat-${workspace.workspaceId}`}
        >
          {workspace.diffComparisonError ? <Text style={styles.timestamp}>!</Text> : null}
          {workspace.diffStat ? (
            <DiffStat
              additions={workspace.diffStat.additions}
              deletions={workspace.diffStat.deletions}
            />
          ) : null}
        </Pressable>
      </TooltipTrigger>
      <TooltipContent>
        <Text style={styles.tooltip}>{description}</Text>
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * Its own component so the clock stops here. `useCompactTimeAgo` holds state, and state
 * re-renders the component that owns it — keeping that component down to a single `<Text>` is
 * what stops a minute tick from reaching the row, the list, or the diff stat next door.
 */
function WorkspaceTimestamp({ enteredAt }: { enteredAt: Date }) {
  const label = useCompactTimeAgo(enteredAt);
  return (
    <Text style={styles.timestamp} numberOfLines={1} testID="sidebar-workspace-timestamp">
      {label}
    </Text>
  );
}

const styles = StyleSheet.create((theme) => ({
  tooltip: { color: theme.colors.foreground, fontSize: theme.fontSize.sm },
  // A step below the project title it shares the row with. The timestamp is the one thing here
  // you never came looking for, so it sits at the bottom of the muted ramp rather than tying
  // with the label naming the group.
  timestamp: {
    height: 20,
    lineHeight: 20,
    color: theme.colors.foregroundExtraMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
    flexShrink: 0,
  },
}));
