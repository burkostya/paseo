import { useCallback, useMemo, useRef, useState } from "react";
import { GitBranch } from "lucide-react-native";
import { Pressable, Text, View, type PressableStateCallbackType } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import {
  Combobox,
  ComboboxItem,
  type ComboboxOption,
  type ComboboxProps,
} from "@/components/ui/combobox";
import { useFetchQuery } from "@/data/query";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import type { Theme } from "@/styles/theme";

const DEFAULT_OPTION_ID = "default";
const BRANCH_OPTION_PREFIX = "branch:";

const foregroundMutedIconColorMapping = (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
});

const ThemedGitBranch = withUnistyles(GitBranch);

function branchOptionId(branch: string): string {
  return `${BRANCH_OPTION_PREFIX}${branch}`;
}

function triggerStyle({
  hovered = false,
  pressed,
}: PressableStateCallbackType & { hovered?: boolean }) {
  return [styles.trigger, (Boolean(hovered) || pressed) && styles.triggerHovered];
}

export interface DiffBasePickerProps {
  serverId: string;
  workspaceId?: string | null;
  cwd: string;
  selectedBaseRef: string | null;
  defaultBaseRefLabel: string;
  effectiveBaseRefLabel: string;
  onSelect: (baseRef: string | null) => void;
}

export function DiffBasePicker({
  serverId,
  workspaceId,
  cwd,
  selectedBaseRef,
  defaultBaseRefLabel,
  effectiveBaseRefLabel,
  onSelect,
}: DiffBasePickerProps) {
  const { t } = useTranslation();
  const anchorRef = useRef<View>(null);
  const client = useHostRuntimeClient(serverId);
  const isConnected = useHostRuntimeIsConnected(serverId);
  const [isOpen, setIsOpen] = useState(false);

  const branchesQuery = useFetchQuery({
    queryKey: ["branchSuggestions", serverId, workspaceId?.trim() || cwd],
    dataShape: "list",
    queryFn: async () => {
      if (!client) {
        throw new Error(t("common.errors.daemonClientUnavailable"));
      }
      const payload = await client.getBranchSuggestions({ cwd, limit: 200 });
      if (payload.error) {
        throw new Error(payload.error);
      }
      return payload.branches ?? [];
    },
    enabled: isOpen && isConnected && Boolean(client),
    retry: false,
    staleTimeMs: 15_000,
  });

  const branchNames = useMemo(() => {
    const available = branchesQuery.data ?? [];
    if (!selectedBaseRef || available.includes(selectedBaseRef)) {
      return available;
    }
    return [selectedBaseRef, ...available];
  }, [branchesQuery.data, selectedBaseRef]);

  const options = useMemo<ComboboxOption[]>(
    () => [
      {
        id: DEFAULT_OPTION_ID,
        label: t("workspace.git.diff.basePicker.default"),
        description: defaultBaseRefLabel,
      },
      ...branchNames.map((branch) => ({ id: branchOptionId(branch), label: branch })),
    ],
    [branchNames, defaultBaseRefLabel, t],
  );

  const handleOpen = useCallback(() => setIsOpen(true), []);
  const handleSelect = useCallback(
    (optionId: string) => {
      if (optionId === DEFAULT_OPTION_ID) {
        onSelect(null);
        return;
      }
      if (optionId.startsWith(BRANCH_OPTION_PREFIX)) {
        onSelect(optionId.slice(BRANCH_OPTION_PREFIX.length));
      }
    },
    [onSelect],
  );

  const branchLeadingSlot = useMemo(
    () => <ThemedGitBranch size={14} uniProps={foregroundMutedIconColorMapping} />,
    [],
  );
  const renderOption = useCallback<NonNullable<ComboboxProps["renderOption"]>>(
    ({ option, selected, active, onPress }) => (
      <ComboboxItem
        label={option.label}
        description={option.description}
        selected={selected}
        active={active}
        onPress={onPress}
        leadingSlot={branchLeadingSlot}
        testID={
          option.id === DEFAULT_OPTION_ID
            ? "changes-diff-base-default"
            : `changes-diff-base-${option.label}`
        }
      />
    ),
    [branchLeadingSlot],
  );
  const emptyText =
    branchesQuery.error instanceof Error
      ? branchesQuery.error.message
      : t("workspace.git.diff.basePicker.empty");

  return (
    <View ref={anchorRef} collapsable={false} style={styles.anchor}>
      <Pressable
        testID="changes-diff-base-trigger"
        accessibilityRole="button"
        accessibilityLabel={t("workspace.git.diff.basePicker.accessibility", {
          baseRef: effectiveBaseRefLabel,
        })}
        onPress={handleOpen}
        style={triggerStyle}
      >
        <Text style={styles.triggerText} numberOfLines={1}>
          {t("workspace.git.diff.basePicker.trigger", { baseRef: effectiveBaseRefLabel })}
        </Text>
      </Pressable>
      <Combobox
        options={options}
        value={selectedBaseRef ? branchOptionId(selectedBaseRef) : DEFAULT_OPTION_ID}
        onSelect={handleSelect}
        searchable
        placeholder={t("workspace.git.diff.basePicker.placeholder")}
        searchPlaceholder={t("workspace.git.diff.basePicker.searchPlaceholder")}
        emptyText={emptyText}
        title={t("workspace.git.diff.basePicker.title")}
        open={isOpen}
        onOpenChange={setIsOpen}
        anchorRef={anchorRef}
        desktopPlacement="bottom-start"
        desktopPreventInitialFlash
        desktopMinWidth={280}
        renderOption={renderOption}
      />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  anchor: {
    minWidth: 0,
    flexShrink: 1,
  },
  trigger: {
    minWidth: 0,
    flexShrink: 1,
    justifyContent: "center",
    height: {
      xs: 28,
      sm: 28,
      md: 24,
    },
    paddingHorizontal: theme.spacing[1],
    borderRadius: theme.borderRadius.base,
  },
  triggerHovered: {
    backgroundColor: theme.colors.surface2,
  },
  triggerText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    lineHeight: theme.fontSize.sm * 1.25,
  },
}));
