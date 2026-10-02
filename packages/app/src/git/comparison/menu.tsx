import { comparisonLabel } from "./label";
import { useCallback, useMemo, useState } from "react";
import { Text } from "react-native";
import { useTranslation } from "react-i18next";
import { useMutation } from "@tanstack/react-query";
import type { DiffComparison, SessionInboundMessage } from "@getpaseo/protocol/messages";
import { MenuHint, MenuItem, MenuTextField, type MenuPageDefinition } from "@/components/ui/menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { useWorkspace } from "@/stores/session-store-hooks";
import { useSessionStore } from "@/stores/session-store";
import { useFetchQuery } from "@/data/query";
import { StyleSheet } from "react-native-unistyles";

export type ComparisonTarget = Extract<
  SessionInboundMessage,
  { type: "git.comparison.set.request" }
>["target"];
export const COMPARISON_PAGE = "gitComparison";
const UNCOMMITTED: DiffComparison = { mode: "uncommitted" };

interface ComparisonMenuProps {
  serverId: string;
  target: ComparisonTarget;
  cwd?: string;
}

function useComparisonTarget({ serverId, target, cwd }: ComparisonMenuProps) {
  const workspace = useWorkspace(serverId, target.kind === "workspace" ? target.workspaceId : null);
  const project = useSessionStore((state) =>
    target.kind === "project"
      ? state.sessions[serverId]?.projects.get(target.projectId)
      : undefined,
  );
  const inherited = workspace?.projectDiffComparison ?? UNCOMMITTED;
  const selection =
    target.kind === "workspace" ? workspace?.diffComparisonOverride : project?.diffComparison;
  const effective =
    target.kind === "workspace" ? workspace?.diffComparison : project?.diffComparison;
  return {
    inherited,
    selection,
    effective: effective ?? UNCOMMITTED,
    cwd: cwd ?? workspace?.workspaceDirectory ?? project?.projectRootPath ?? "",
  };
}

function ComparisonPage(props: ComparisonMenuProps) {
  const { t } = useTranslation();
  const supported = useHostFeature(props.serverId, "workspaceDiffComparison");
  const client = useHostRuntimeClient(props.serverId);
  const { inherited, selection, effective, cwd } = useComparisonTarget(props);
  const [search, setSearch] = useState("");
  const mutation = useMutation({
    mutationFn: async (comparison: DiffComparison | null) => {
      if (!client) throw new Error(t("common.errors.daemonClientUnavailable"));
      await client.setDiffComparison(props.target, comparison);
    },
  });
  const branches = useFetchQuery({
    queryKey: ["comparisonBranches", props.serverId, cwd, search],
    dataShape: "list",
    queryFn: async () => {
      if (!client) throw new Error(t("common.errors.daemonClientUnavailable"));
      const result = await client.getBranchSuggestions({
        cwd,
        query: search,
        limit: 200,
        exactRefs: true,
      });
      if (result.error) throw new Error(result.error);
      return result.branches ?? [];
    },
    enabled: supported && Boolean(cwd && client),
    retry: false,
    staleTimeMs: 15000,
  });
  const choose = mutation.mutate;
  const inherit = useCallback(() => choose(null), [choose]);
  const uncommitted = useCallback(() => choose(UNCOMMITTED), [choose]);
  const refetch = branches.refetch;
  const retry = useCallback(() => void refetch(), [refetch]);
  if (!supported) return <MenuHint>{t("diffComparison.updateHost")}</MenuHint>;
  return (
    <>
      {props.target.kind === "workspace" ? (
        <MenuItem
          closeOnSelect={false}
          selected={!selection}
          disabled={mutation.isPending}
          description={comparisonLabel(inherited, t)}
          onSelect={inherit}
          testID="comparison-inherit"
        >
          {t("diffComparison.inherit")}
        </MenuItem>
      ) : null}
      <MenuItem
        closeOnSelect={false}
        selected={
          selection?.mode === "uncommitted" || (props.target.kind === "project" && !selection)
        }
        disabled={mutation.isPending}
        onSelect={uncommitted}
        testID="comparison-uncommitted"
      >
        {t("diffComparison.uncommitted")}
      </MenuItem>
      {mutation.isPending ? <MenuHint>{t("diffComparison.saving")}</MenuHint> : null}
      {mutation.isError ? <MenuHint>{mutation.error.message}</MenuHint> : null}
      {mutation.isSuccess ? <MenuHint>{t("diffComparison.saved")}</MenuHint> : null}
      <MenuHint>{t("diffComparison.chooseBranch")}</MenuHint>
      <MenuTextField
        initialValue={search}
        onChangeText={setSearch}
        placeholder={t("diffComparison.search")}
        testID="comparison-search"
      />
      {branches.data?.map((branch) => (
        <BranchOption
          key={branch}
          branch={branch}
          effective={effective}
          pending={mutation.isPending}
          choose={choose}
        />
      ))}
      {branches.isLoading ? <MenuHint>{t("common.loading")}</MenuHint> : null}
      {branches.error ? (
        <MenuItem closeOnSelect={false} description={branches.error.message} onSelect={retry}>
          {t("diffComparison.retry")}
        </MenuItem>
      ) : null}
    </>
  );
}

function BranchOption({
  branch,
  effective,
  pending,
  choose,
}: {
  branch: string;
  effective: DiffComparison | undefined;
  pending: boolean;
  choose: (comparison: DiffComparison) => void;
}) {
  const select = useCallback(() => choose({ mode: "base", baseRef: branch }), [branch, choose]);
  return (
    <MenuItem
      closeOnSelect={false}
      disabled={pending}
      selected={effective?.mode === "base" && effective.baseRef === branch}
      onSelect={select}
      testID={`comparison-branch-${branch}`}
    >
      {branch.replace(/^refs\/(heads|remotes)\//, "")}
    </MenuItem>
  );
}

export function WorkspaceComparisonDropdown({
  serverId,
  workspaceId,
  cwd,
}: {
  serverId: string;
  workspaceId: string;
  cwd: string;
}) {
  const target = useMemo<ComparisonTarget>(
    () => ({ kind: "workspace", workspaceId }),
    [workspaceId],
  );
  return <ComparisonDropdown serverId={serverId} target={target} cwd={cwd} />;
}

export function useComparisonMenuPages(
  props: ComparisonMenuProps | null,
): readonly MenuPageDefinition[] {
  const { t } = useTranslation();
  return useMemo(
    () =>
      props
        ? [
            {
              id: COMPARISON_PAGE,
              title: t("diffComparison.title"),
              hoverIntent: false,
              content: <ComparisonPage {...props} />,
            },
          ]
        : [],
    [props, t],
  );
}

export function ComparisonMenuTrigger() {
  const { t } = useTranslation();
  return (
    <DropdownMenuSubTrigger id={COMPARISON_PAGE} testID="comparison-menu">
      {t("diffComparison.title")}
    </DropdownMenuSubTrigger>
  );
}

export function ComparisonDropdown(props: ComparisonMenuProps) {
  const { t } = useTranslation();
  const { effective } = useComparisonTarget(props);
  return (
    <DropdownMenu compactMode="sheet">
      <DropdownMenuTrigger
        accessibilityLabel={t("diffComparison.title")}
        testID="changes-comparison-trigger"
      >
        <Text style={styles.label} numberOfLines={1}>
          {comparisonLabel(effective, t)}
        </Text>
      </DropdownMenuTrigger>
      <DropdownMenuContent width={300} align="start" sheetTitle={t("diffComparison.title")}>
        <ComparisonPage {...props} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const styles = StyleSheet.create((theme) => ({
  label: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    paddingVertical: theme.spacing[1],
  },
}));
