import {
  useCallback,
  useMemo,
  useState,
  type ComponentProps,
  type PropsWithChildren,
  type ReactNode,
  type ReactElement,
} from "react";
import { useTranslation } from "react-i18next";
import { type PressableStateCallbackType } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import {
  Archive,
  Circle,
  CircleCheck,
  Copy,
  MoreVertical,
  Pencil,
  Pin,
  PinOff,
  Tag,
  FolderTree,
  CornerUpLeft,
} from "lucide-react-native";
import { isWeb } from "@/constants/platform";
import { getForgePresentation, normalizeForge } from "@/git/forge";
import type { SidebarWorkspaceEntry } from "@/hooks/use-sidebar-workspaces-list";
import { useAppSettings } from "@/hooks/use-settings";
import type { Theme } from "@/styles/theme";
import type { ShortcutKey } from "@/utils/format-shortcut";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { MenuHint, MenuItem, MenuTextField, type MenuPageDefinition } from "@/components/ui/menu";
import { Shortcut } from "@/components/ui/shortcut";
import { OpenInFileManagerMenuItem } from "@/workspace/open-in-file-manager/menu-item";
import { resolveSidebarWorkspaceAccessibilityLabel } from "@/components/sidebar/sidebar-workspace-title";
import {
  workspaceServiceLabelKey,
  type WorkspaceServiceSummary,
} from "@/components/sidebar/workspace-meta-row";
import {
  useWorkspaceLabelMenuPages,
  WORKSPACE_LABEL_PAGE_ID,
  type WorkspaceLabelTarget,
} from "@/workspace-labels/picker";

const foregroundColorMapping = (theme: Theme) => ({ color: theme.colors.foreground });
const foregroundMutedColorMapping = (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
});

const ThemedMoreVertical = withUnistyles(MoreVertical);
const ThemedCopy = withUnistyles(Copy);
const ThemedArchive = withUnistyles(Archive);
const ThemedCircle = withUnistyles(Circle);
const ThemedPencil = withUnistyles(Pencil);
const ThemedCircleCheck = withUnistyles(CircleCheck);
const ThemedPin = withUnistyles(Pin);
const ThemedPinOff = withUnistyles(PinOff);
const ThemedTag = withUnistyles(Tag);
const ThemedFolderTree = withUnistyles(FolderTree);
const ThemedCornerUpLeft = withUnistyles(CornerUpLeft);

const copyLeadingIcon = <ThemedCopy size={14} uniProps={foregroundMutedColorMapping} />;
const renameLeadingIcon = <ThemedPencil size={14} uniProps={foregroundMutedColorMapping} />;
const markAsReadLeadingIcon = (
  <ThemedCircleCheck size={14} uniProps={foregroundMutedColorMapping} />
);
const markAsUnreadLeadingIcon = <ThemedCircle size={14} uniProps={foregroundMutedColorMapping} />;
const archiveLeadingIcon = <ThemedArchive size={14} uniProps={foregroundMutedColorMapping} />;
const pinLeadingIcon = <ThemedPin size={14} uniProps={foregroundMutedColorMapping} />;
const unpinLeadingIcon = <ThemedPinOff size={14} uniProps={foregroundMutedColorMapping} />;
const hierarchyLeadingIcon = <ThemedFolderTree size={14} uniProps={foregroundMutedColorMapping} />;
const rootLeadingIcon = <ThemedCornerUpLeft size={14} uniProps={foregroundMutedColorMapping} />;

export interface WorkspaceParentCandidate {
  workspaceKey: string;
  serverId: string;
  workspaceId: string;
  projectId?: string;
  name: string;
  parentWorkspaceId?: string | null;
}

const WORKSPACE_HIERARCHY_PAGE_ID = "workspaceHierarchy";

function useWorkspaceHierarchyMenuPages(input: {
  workspaceKey: string;
  serverId?: string;
  workspaceId?: string;
  projectId?: string;
  parentWorkspaceId?: string | null;
  candidates?: readonly WorkspaceParentCandidate[];
  onSetParent?: (parentWorkspaceId: string | null) => void | Promise<void>;
  parentUpdatePending?: boolean;
}): readonly MenuPageDefinition[] {
  const { t } = useTranslation();
  const {
    workspaceKey,
    serverId,
    workspaceId,
    projectId,
    parentWorkspaceId,
    candidates,
    onSetParent,
    parentUpdatePending = false,
  } = input;
  return useMemo(() => {
    if (!serverId || !workspaceId || !onSetParent) return [];
    return [
      {
        id: WORKSPACE_HIERARCHY_PAGE_ID,
        title: t("sidebar.workspace.hierarchy.title"),
        hoverIntent: false,
        content: (
          <WorkspaceParentPickerPage
            workspaceKey={workspaceKey}
            serverId={serverId}
            workspaceId={workspaceId}
            projectId={projectId}
            parentWorkspaceId={parentWorkspaceId ?? null}
            candidates={candidates ?? []}
            onSetParent={onSetParent}
            parentUpdatePending={parentUpdatePending}
          />
        ),
      },
    ];
  }, [
    candidates,
    onSetParent,
    parentWorkspaceId,
    projectId,
    serverId,
    t,
    workspaceId,
    workspaceKey,
    parentUpdatePending,
  ]);
}

function WorkspaceParentPickerPage({
  workspaceKey,
  serverId,
  workspaceId,
  projectId,
  parentWorkspaceId,
  candidates,
  onSetParent,
  parentUpdatePending,
}: {
  workspaceKey: string;
  serverId: string;
  workspaceId: string;
  projectId?: string;
  parentWorkspaceId: string | null;
  candidates: readonly WorkspaceParentCandidate[];
  onSetParent: (parentWorkspaceId: string | null) => void | Promise<void>;
  parentUpdatePending: boolean;
}): ReactElement {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const scopedCandidates = useMemo(
    () =>
      candidates.filter(
        (candidate) =>
          candidate.serverId === serverId &&
          (projectId ? candidate.projectId === projectId : !candidate.projectId),
      ),
    [candidates, projectId, serverId],
  );
  const availableCandidates = useMemo(() => {
    const candidateKey = (candidate: Pick<WorkspaceParentCandidate, "serverId" | "workspaceId">) =>
      `${candidate.serverId}\u0000${candidate.workspaceId}`;
    const byKey = new Map(
      scopedCandidates.map((candidate) => [candidateKey(candidate), candidate]),
    );
    const descendants = new Set<string>();
    const children = new Map<string, string[]>();
    for (const candidate of scopedCandidates) {
      const parentId = candidate.parentWorkspaceId ?? null;
      if (!parentId) continue;
      const parentKey = `${candidate.serverId}\u0000${parentId}`;
      if (!byKey.has(parentKey)) continue;
      const list = children.get(parentKey) ?? [];
      list.push(candidateKey(candidate));
      children.set(parentKey, list);
    }
    const currentKey = `${serverId}\u0000${workspaceId}`;
    const stack = [...(children.get(currentKey) ?? [])];
    while (stack.length) {
      const key = stack.pop()!;
      if (descendants.has(key)) continue;
      descendants.add(key);
      stack.push(...(children.get(key) ?? []));
    }
    return scopedCandidates
      .filter(
        (candidate) =>
          candidate.workspaceId !== workspaceId && !descendants.has(candidateKey(candidate)),
      )
      .filter((candidate) => {
        if (!normalizedQuery) return true;
        return candidate.name.toLocaleLowerCase().includes(normalizedQuery);
      });
  }, [normalizedQuery, scopedCandidates, serverId, workspaceId]);
  const selectParent = useCallback(
    (parent: string | null) => {
      if (parent === parentWorkspaceId) return;
      onSetParent(parent);
    },
    [onSetParent, parentWorkspaceId],
  );
  const selectRoot = useCallback(() => selectParent(null), [selectParent]);

  return (
    <>
      <MenuTextField
        initialValue=""
        onChangeText={setQuery}
        placeholder={t("sidebar.workspace.hierarchy.search")}
        accessibilityLabel={t("sidebar.workspace.hierarchy.search")}
        autoFocus
        editable={!parentUpdatePending}
        testID={`sidebar-workspace-hierarchy-search-${workspaceKey}`}
      />
      {parentWorkspaceId !== null ? (
        <MenuItem
          leading={rootLeadingIcon}
          selected={parentWorkspaceId === null}
          onSelect={selectRoot}
          disabled={parentUpdatePending}
          testID={`sidebar-workspace-hierarchy-root-${workspaceKey}`}
        >
          {t("sidebar.workspace.hierarchy.root")}
        </MenuItem>
      ) : null}
      {availableCandidates.map((candidate) => (
        <WorkspaceParentCandidateItem
          key={candidate.workspaceKey}
          candidate={candidate}
          candidates={scopedCandidates}
          selected={candidate.workspaceId === parentWorkspaceId}
          onSelect={selectParent}
          disabled={parentUpdatePending}
          testID={`sidebar-workspace-hierarchy-parent-${candidate.workspaceKey}`}
        />
      ))}
      {availableCandidates.length === 0 ? (
        <MenuHint>{t("sidebar.workspace.hierarchy.noCandidates")}</MenuHint>
      ) : null}
    </>
  );
}

function WorkspaceParentCandidateItem({
  candidate,
  candidates,
  selected,
  onSelect,
  disabled = false,
  testID,
}: {
  candidate: WorkspaceParentCandidate;
  candidates: readonly WorkspaceParentCandidate[];
  selected: boolean;
  onSelect: (workspaceId: string) => void;
  disabled?: boolean;
  testID: string;
}): ReactElement {
  const handleSelect = useCallback(
    () => onSelect(candidate.workspaceId),
    [candidate.workspaceId, onSelect],
  );
  return (
    <MenuItem selected={selected} onSelect={handleSelect} disabled={disabled} testID={testID}>
      {resolveWorkspaceParentCandidateLabel(candidate, candidates)}
    </MenuItem>
  );
}

function resolveWorkspaceParentCandidateLabel(
  candidate: WorkspaceParentCandidate,
  candidates: readonly WorkspaceParentCandidate[],
): string {
  const byKey = new Map(
    candidates.map((item) => [`${item.serverId}\u0000${item.workspaceId}`, item] as const),
  );
  const names = [candidate.name];
  const visited = new Set<string>();
  let current = candidate;
  while (current.parentWorkspaceId) {
    const currentKey = `${current.serverId}\u0000${current.workspaceId}`;
    if (visited.has(currentKey)) break;
    visited.add(currentKey);
    const parent = byKey.get(`${current.serverId}\u0000${current.parentWorkspaceId}`);
    if (!parent) break;
    names.unshift(parent.name);
    current = parent;
  }
  return names.join(" / ");
}

function renderTriggerIcon({ hovered }: { hovered?: boolean }) {
  return (
    <ThemedMoreVertical
      size={14}
      uniProps={hovered ? foregroundColorMapping : foregroundMutedColorMapping}
    />
  );
}

export interface SidebarWorkspaceMenuProps {
  workspaceKey: string;
  serverId?: string;
  workspaceId?: string;
  projectId?: string;
  parentWorkspaceId?: string | null;
  workspaceParentCandidates?: readonly WorkspaceParentCandidate[];
  onSetParent?: (parentWorkspaceId: string | null) => void | Promise<void>;
  parentUpdatePending?: boolean;
  workspaceLabels?: readonly string[];
  onCopyPath?: () => void;
  onCopyBranchName?: () => void;
  onRename?: () => void;
  onMarkAsRead?: () => void;
  onMarkAsUnread?: () => void;
  onArchive?: () => void;
  archiveLabel?: string;
  archiveStatus?: "idle" | "pending" | "success";
  archivePendingLabel?: string;
  archiveShortcutKeys?: ShortcutKey[][] | null;
  isPinned?: boolean;
  onTogglePin?: () => void;
  openInFileManagerPath?: string | null;
  /**
   * Lifted so the row that reveals the kebab can keep it mounted while its menu is up. See
   * `useOpenKebabMenuVisibility`.
   */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

interface SidebarWorkspaceMenuItemsProps extends Omit<
  SidebarWorkspaceMenuProps,
  "onArchive" | "open" | "onOpenChange"
> {
  onArchive?: () => void;
}

type MenuSurface = "context" | "dropdown";

function WorkspaceMenuItem({
  surface,
  children,
  ...props
}: PropsWithChildren<
  Omit<ComponentProps<typeof DropdownMenuItem>, "children"> & { surface: MenuSurface }
>) {
  if (surface === "context") {
    return <ContextMenuItem {...props}>{children}</ContextMenuItem>;
  }
  return <DropdownMenuItem {...props}>{children}</DropdownMenuItem>;
}

function SidebarWorkspaceMenuItems({
  surface,
  workspaceKey,
  serverId,
  workspaceId,
  onSetParent,
  parentUpdatePending = false,
  onCopyPath,
  onCopyBranchName,
  onRename,
  onMarkAsRead,
  onMarkAsUnread,
  onArchive,
  archiveLabel,
  archiveStatus,
  archivePendingLabel,
  archiveShortcutKeys,
  isPinned,
  onTogglePin,
  openInFileManagerPath,
}: SidebarWorkspaceMenuItemsProps & { surface: MenuSurface }): ReactNode {
  const { t } = useTranslation();
  const archiveTrailing = useMemo(
    () => (archiveShortcutKeys ? <Shortcut chord={archiveShortcutKeys} /> : null),
    [archiveShortcutKeys],
  );
  const labelLeading = useMemo(
    () => <ThemedTag size={14} uniProps={foregroundMutedColorMapping} />,
    [],
  );
  return (
    <>
      {onCopyPath ? (
        <WorkspaceMenuItem
          surface={surface}
          testID={`sidebar-workspace-menu-copy-path-${workspaceKey}`}
          leading={copyLeadingIcon}
          onSelect={onCopyPath}
        >
          {t("sidebar.workspace.actions.copyPath")}
        </WorkspaceMenuItem>
      ) : null}
      {onCopyBranchName ? (
        <WorkspaceMenuItem
          surface={surface}
          testID={`sidebar-workspace-menu-copy-branch-name-${workspaceKey}`}
          leading={copyLeadingIcon}
          onSelect={onCopyBranchName}
        >
          {t("sidebar.workspace.actions.copyBranchName")}
        </WorkspaceMenuItem>
      ) : null}
      {onRename ? (
        <WorkspaceMenuItem
          surface={surface}
          testID={`sidebar-workspace-menu-rename-${workspaceKey}`}
          leading={renameLeadingIcon}
          onSelect={onRename}
        >
          {t("sidebar.workspace.actions.rename")}
        </WorkspaceMenuItem>
      ) : null}
      {onMarkAsRead ? (
        <WorkspaceMenuItem
          surface={surface}
          testID={`sidebar-workspace-menu-mark-as-read-${workspaceKey}`}
          leading={markAsReadLeadingIcon}
          onSelect={onMarkAsRead}
        >
          Mark as read
        </WorkspaceMenuItem>
      ) : null}
      {onMarkAsUnread ? (
        <WorkspaceMenuItem
          surface={surface}
          testID={`sidebar-workspace-menu-mark-as-unread-${workspaceKey}`}
          leading={markAsUnreadLeadingIcon}
          onSelect={onMarkAsUnread}
        >
          Mark as unread
        </WorkspaceMenuItem>
      ) : null}
      {onTogglePin ? (
        <WorkspaceMenuItem
          surface={surface}
          testID={`sidebar-workspace-menu-pin-${workspaceKey}`}
          leading={isPinned ? unpinLeadingIcon : pinLeadingIcon}
          onSelect={onTogglePin}
        >
          {isPinned ? t("sidebar.workspace.actions.unpin") : t("sidebar.workspace.actions.pin")}
        </WorkspaceMenuItem>
      ) : null}
      {serverId && workspaceId && onSetParent ? (
        <DropdownMenuSubTrigger
          id={WORKSPACE_HIERARCHY_PAGE_ID}
          leading={hierarchyLeadingIcon}
          disabled={parentUpdatePending}
          testID={`sidebar-workspace-menu-hierarchy-${workspaceKey}`}
        >
          {t("sidebar.workspace.hierarchy.moveTo")}
        </DropdownMenuSubTrigger>
      ) : null}
      {serverId && workspaceId ? (
        <DropdownMenuSubTrigger
          id={WORKSPACE_LABEL_PAGE_ID}
          leading={labelLeading}
          testID={`sidebar-workspace-menu-labels-${workspaceKey}`}
        >
          {t("workspaceLabels.title")}
        </DropdownMenuSubTrigger>
      ) : null}
      <OpenInFileManagerMenuItem
        surface={surface}
        path={openInFileManagerPath}
        testID={`sidebar-workspace-menu-open-folder-${workspaceKey}`}
      />
      {onArchive ? (
        <WorkspaceMenuItem
          surface={surface}
          testID={`sidebar-workspace-menu-archive-${workspaceKey}`}
          leading={archiveLeadingIcon}
          trailing={archiveTrailing}
          status={archiveStatus}
          pendingLabel={archivePendingLabel}
          onSelect={onArchive}
        >
          {archiveLabel ?? t("sidebar.workspace.actions.archive")}
        </WorkspaceMenuItem>
      ) : null}
    </>
  );
}

export function SidebarWorkspaceMenu({
  workspaceKey,
  serverId,
  workspaceId,
  projectId,
  parentWorkspaceId,
  workspaceParentCandidates,
  onSetParent,
  parentUpdatePending = false,
  workspaceLabels,
  onCopyPath,
  onCopyBranchName,
  onRename,
  onMarkAsRead,
  onMarkAsUnread,
  onArchive,
  archiveLabel,
  archiveStatus,
  archivePendingLabel,
  archiveShortcutKeys,
  isPinned,
  onTogglePin,
  openInFileManagerPath,
  open,
  onOpenChange,
}: SidebarWorkspaceMenuProps) {
  const { t } = useTranslation();
  const workspaceTarget = useMemo<WorkspaceLabelTarget | null>(
    () =>
      serverId && workspaceId ? { serverId, workspaceId, labels: workspaceLabels ?? [] } : null,
    [serverId, workspaceId, workspaceLabels],
  );
  const pages = useWorkspaceLabelMenuPages(workspaceTarget);
  const hierarchyPages = useWorkspaceHierarchyMenuPages({
    workspaceKey,
    serverId,
    workspaceId,
    projectId,
    parentWorkspaceId,
    candidates: workspaceParentCandidates,
    onSetParent,
    parentUpdatePending,
  });
  return (
    <DropdownMenu compactMode="sheet" open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger
        hitSlop={8}
        style={triggerStyle}
        accessibilityRole={isWeb ? undefined : "button"}
        accessibilityLabel={t("sidebar.workspace.actions.menu")}
        testID={`sidebar-workspace-kebab-${workspaceKey}`}
      >
        {renderTriggerIcon}
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        width={260}
        pages={[...pages, ...hierarchyPages]}
        sheetTitle={t("sidebar.workspace.actions.menu")}
      >
        <SidebarWorkspaceMenuItems
          surface="dropdown"
          workspaceKey={workspaceKey}
          serverId={serverId}
          workspaceId={workspaceId}
          projectId={projectId}
          parentWorkspaceId={parentWorkspaceId}
          workspaceParentCandidates={workspaceParentCandidates}
          onSetParent={onSetParent}
          parentUpdatePending={parentUpdatePending}
          workspaceLabels={workspaceLabels}
          onCopyPath={onCopyPath}
          onCopyBranchName={onCopyBranchName}
          onRename={onRename}
          onMarkAsRead={onMarkAsRead}
          onMarkAsUnread={onMarkAsUnread}
          onArchive={onArchive}
          archiveLabel={archiveLabel}
          archiveStatus={archiveStatus}
          archivePendingLabel={archivePendingLabel}
          archiveShortcutKeys={archiveShortcutKeys}
          isPinned={isPinned}
          onTogglePin={onTogglePin}
          openInFileManagerPath={openInFileManagerPath}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

type ContextTriggerProps = Omit<
  ComponentProps<typeof ContextMenuTrigger>,
  "children" | "enabledOnMobile" | "highlightStyle"
>;

export function SidebarWorkspaceContextMenu({
  children,
  contextMenuOpen,
  onContextMenuOpenChange,
  workspace,
  leadingProjectName,
  hostBadgeLabel,
  serviceSummary,
  workspaceKey,
  parentWorkspaceId,
  workspaceParentCandidates,
  onSetParent,
  parentUpdatePending = false,
  onCopyPath,
  onCopyBranchName,
  onRename,
  onMarkAsRead,
  onMarkAsUnread,
  onArchive,
  archiveLabel,
  archiveStatus,
  archivePendingLabel,
  archiveShortcutKeys,
  isPinned,
  onTogglePin,
  openInFileManagerPath,
  accessibilityLabel,
  highlightStyle,
  ...triggerProps
}: PropsWithChildren<
  SidebarWorkspaceMenuItemsProps &
    ContextTriggerProps & {
      contextMenuOpen: boolean;
      onContextMenuOpenChange: (open: boolean) => void;
      workspace: SidebarWorkspaceEntry;
      leadingProjectName?: string | null;
      hostBadgeLabel?: string | null;
      serviceSummary?: WorkspaceServiceSummary | null;
      highlightStyle: ComponentProps<typeof ContextMenuTrigger>["highlightStyle"];
    }
>) {
  const {
    settings: { workspaceTitleSource },
  } = useAppSettings();
  const { t } = useTranslation();
  const pullRequestLabel = workspace.prHint
    ? t("workspace.git.pr.accessibility.pullRequest", {
        number: workspace.prHint.number,
        context: getForgePresentation(normalizeForge(workspace.prHint.forge)).changeRequestContext,
      })
    : null;
  const rowAccessibilityLabel = resolveSidebarWorkspaceAccessibilityLabel({
    workspace,
    workspaceTitleSource,
    leadingProjectName,
    hostBadgeLabel,
    pullRequestLabel,
    serviceLabel: serviceSummary
      ? t(workspaceServiceLabelKey(serviceSummary), { name: serviceSummary.name })
      : null,
  });
  const workspaceTarget = useMemo<WorkspaceLabelTarget>(
    () => ({
      serverId: workspace.serverId,
      workspaceId: workspace.workspaceId,
      labels: workspace.labels ?? [],
    }),
    [workspace],
  );
  const pages = useWorkspaceLabelMenuPages(workspaceTarget);
  const hierarchyPages = useWorkspaceHierarchyMenuPages({
    workspaceKey,
    serverId: workspace.serverId,
    workspaceId: workspace.workspaceId,
    projectId: workspace.projectId,
    parentWorkspaceId: parentWorkspaceId ?? workspace.parentWorkspaceId ?? null,
    candidates: workspaceParentCandidates,
    onSetParent,
    parentUpdatePending,
  });

  return (
    <ContextMenu open={contextMenuOpen} onOpenChange={onContextMenuOpenChange}>
      <ContextMenuTrigger
        {...triggerProps}
        enabledOnMobile={false}
        accessibilityLabel={accessibilityLabel ?? rowAccessibilityLabel}
        highlightStyle={highlightStyle}
      >
        {children}
      </ContextMenuTrigger>
      <ContextMenuContent
        align="start"
        width={260}
        testID={`sidebar-workspace-context-menu-${workspaceKey}`}
        pages={[...pages, ...hierarchyPages]}
      >
        <SidebarWorkspaceMenuItems
          surface="context"
          workspaceKey={workspaceKey}
          serverId={workspaceTarget.serverId}
          workspaceId={workspaceTarget.workspaceId}
          projectId={workspace.projectId}
          parentWorkspaceId={parentWorkspaceId ?? workspace.parentWorkspaceId ?? null}
          workspaceParentCandidates={workspaceParentCandidates}
          onSetParent={onSetParent}
          parentUpdatePending={parentUpdatePending}
          workspaceLabels={workspaceTarget.labels}
          onCopyPath={onCopyPath}
          onCopyBranchName={onCopyBranchName}
          onRename={onRename}
          onMarkAsRead={onMarkAsRead}
          onMarkAsUnread={onMarkAsUnread}
          onArchive={onArchive}
          archiveLabel={archiveLabel}
          archiveStatus={archiveStatus}
          archivePendingLabel={archivePendingLabel}
          archiveShortcutKeys={archiveShortcutKeys}
          isPinned={isPinned}
          onTogglePin={onTogglePin}
          openInFileManagerPath={openInFileManagerPath}
        />
      </ContextMenuContent>
    </ContextMenu>
  );
}

function triggerStyle({ hovered = false }: PressableStateCallbackType & { hovered?: boolean }) {
  return [styles.trigger, hovered && styles.triggerHovered];
}

const styles = StyleSheet.create((theme) => ({
  trigger: {
    padding: 2,
    borderRadius: 4,
    marginLeft: 2,
    // MoreVertical paints only around the center of its SVG. Keep the padded hit box, but
    // pull the painted dots through that unused view-box space onto the trailing-content rail.
    marginRight: -7,
  },
  triggerHovered: {
    backgroundColor: theme.colors.surface2,
  },
}));
