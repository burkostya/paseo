import { create } from "zustand";

interface SidebarExpandedSectionsState {
  /** Project keys whose workspace list has been expanded past the first 20 root branches. */
  expandedProjectWorkspaceKeys: Set<string>;
  /** Status group keys whose flat workspace list has been expanded past the first 20 rows. */
  expandedWorkspaceGroupKeys: Set<string>;
  expandedPinned: boolean;
  toggleProjectWorkspaceExpanded: (projectKey: string) => void;
  toggleWorkspaceGroupExpanded: (groupKey: string) => void;
  setWorkspaceGroupExpanded: (groupKey: string, expanded: boolean) => void;
  togglePinnedExpanded: () => void;
  setPinnedExpanded: (expanded: boolean) => void;
  setProjectWorkspaceExpanded: (projectKey: string, expanded: boolean) => void;
}

function toggleKey(keys: Set<string>, key: string): Set<string> {
  const next = new Set(keys);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}

function setKey(keys: Set<string>, key: string, expanded: boolean): Set<string> {
  const next = new Set(keys);
  if (expanded) next.add(key);
  else next.delete(key);
  return next;
}

/**
 * Expansion past a section's visual limit is intentionally transient. It is shared by the
 * renderer and projection so shortcuts always describe the rows currently reachable by sight,
 * while a fresh sidebar starts with the compact first-page view.
 */
export const useSidebarExpandedSectionsStore = create<SidebarExpandedSectionsState>()((set) => ({
  expandedProjectWorkspaceKeys: new Set(),
  expandedWorkspaceGroupKeys: new Set(),
  expandedPinned: false,
  toggleProjectWorkspaceExpanded: (projectKey) =>
    set((state) => ({
      expandedProjectWorkspaceKeys: toggleKey(state.expandedProjectWorkspaceKeys, projectKey),
    })),
  toggleWorkspaceGroupExpanded: (groupKey) =>
    set((state) => ({
      expandedWorkspaceGroupKeys: toggleKey(state.expandedWorkspaceGroupKeys, groupKey),
    })),
  setWorkspaceGroupExpanded: (groupKey, expanded) =>
    set((state) => ({
      expandedWorkspaceGroupKeys: setKey(state.expandedWorkspaceGroupKeys, groupKey, expanded),
    })),
  togglePinnedExpanded: () => set((state) => ({ expandedPinned: !state.expandedPinned })),
  setPinnedExpanded: (expanded) => set({ expandedPinned: expanded }),
  setProjectWorkspaceExpanded: (projectKey, expanded) =>
    set((state) => ({
      expandedProjectWorkspaceKeys: setKey(
        state.expandedProjectWorkspaceKeys,
        projectKey,
        expanded,
      ),
    })),
}));
