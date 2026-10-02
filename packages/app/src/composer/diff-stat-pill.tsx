import { StyleSheet } from "react-native-unistyles";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { Text } from "react-native";
import { useWorkspaceFields } from "@/stores/session-store-hooks";
import { comparisonLabel } from "@/git/comparison/label";
import { memo, useCallback, useMemo, useState, type ReactElement } from "react";
import { Pressable } from "react-native";
import { useTranslation } from "react-i18next";
import { DiffStat } from "@/components/diff-stat";
import { composerPillStyles } from "@/composer/pill-styles";
import { useVisibleWorkspaceDiffStat } from "@/composer/workspace-diff-stat";

interface ComposerDiffStatPillProps {
  additions: number;
  deletions: number;
  onPress: () => void;
  comparisonText?: string;
}

export function ComposerDiffStatPill({
  additions,
  deletions,
  onPress,
  comparisonText,
}: ComposerDiffStatPillProps) {
  const { t } = useTranslation();
  const [isHovered, setIsHovered] = useState(false);
  const handleHoverIn = useCallback(() => setIsHovered(true), []);
  const handleHoverOut = useCallback(() => setIsHovered(false), []);
  const bodyStyle = useMemo(
    () => [composerPillStyles.body, isHovered && composerPillStyles.bodyActive],
    [isHovered],
  );

  return (
    <Tooltip enabledOnDesktop enabledOnMobile={false}>
      <TooltipTrigger asChild>
        <Pressable
          testID="composer-diff-stat-pill"
          accessibilityRole="button"
          accessibilityLabel={t("workspace.git.diff.openChangesTab")}
          onPress={onPress}
          onHoverIn={handleHoverIn}
          onHoverOut={handleHoverOut}
          style={bodyStyle}
        >
          <DiffStat additions={additions} deletions={deletions} />
        </Pressable>
      </TooltipTrigger>
      <TooltipContent>
        <Text style={styles.tooltip}>
          {comparisonText ?? t("workspace.git.diff.openChangesTab")}
        </Text>
      </TooltipContent>
    </Tooltip>
  );
}

export const WorkspaceDiffStatPill = memo(function WorkspaceDiffStatPill({
  serverId,
  workspaceId,
  onPress,
}: {
  serverId: string;
  workspaceId: string;
  onPress: () => void;
}): ReactElement | null {
  const diffStat = useVisibleWorkspaceDiffStat(serverId, workspaceId);
  const comparison = useWorkspaceFields(
    serverId,
    workspaceId,
    (workspace) => workspace.diffComparison,
  );
  const { t } = useTranslation();
  if (!diffStat) {
    return null;
  }
  return (
    <ComposerDiffStatPill
      additions={diffStat.additions}
      deletions={diffStat.deletions}
      onPress={onPress}
      comparisonText={comparisonLabel(comparison ?? undefined, t)}
    />
  );
});

const styles = StyleSheet.create((theme) => ({
  tooltip: { color: theme.colors.foreground, fontSize: theme.fontSize.sm },
}));
