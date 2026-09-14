import { useMemo } from "react";
import type { SidebarProjectEntry } from "@/hooks/use-sidebar-workspaces-list";
import { buildSidebarShortcutModel } from "@/utils/sidebar-shortcuts";
import { useSidebarCollapsedSectionsStore } from "@/stores/sidebar-collapsed-sections-store";
import { useSidebarExpandedSectionsStore } from "@/stores/sidebar-expanded-sections-store";

export function useSidebarShortcutModel(input: { projects: SidebarProjectEntry[] }) {
  const { projects } = input;
  const collapsedProjectKeys = useSidebarCollapsedSectionsStore(
    (state) => state.collapsedProjectKeys,
  );
  const expandedProjectWorkspaceKeys = useSidebarExpandedSectionsStore(
    (state) => state.expandedProjectWorkspaceKeys,
  );
  const collapsedWorkspaceKeys = useSidebarCollapsedSectionsStore(
    (state) => state.collapsedWorkspaceKeys,
  );
  const setProjectCollapsed = useSidebarCollapsedSectionsStore(
    (state) => state.setProjectCollapsed,
  );
  const toggleProjectCollapsed = useSidebarCollapsedSectionsStore(
    (state) => state.toggleProjectCollapsed,
  );

  const shortcutModel = useMemo(
    () =>
      buildSidebarShortcutModel({
        projects,
        collapsedProjectKeys,
        collapsedWorkspaceKeys,
        expandedProjectWorkspaceKeys,
      }),
    [collapsedProjectKeys, collapsedWorkspaceKeys, expandedProjectWorkspaceKeys, projects],
  );

  return {
    collapsedProjectKeys,
    shortcutIndexByWorkspaceKey: shortcutModel.shortcutIndexByWorkspaceKey,
    setProjectCollapsed,
    toggleProjectCollapsed,
  };
}
