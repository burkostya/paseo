import type { ProjectWorktreeCandidate } from "@getpaseo/protocol/messages";

interface ImportPorts {
  list(): Promise<{ worktrees: ProjectWorktreeCandidate[]; error: string | null }>;
  import(path: string): Promise<{ workspaceId: string | null; error: string | null }>;
}

export interface WorktreeImportState {
  status: "loading" | "loaded" | "error" | "importing";
  worktrees: ProjectWorktreeCandidate[];
  selected: ReadonlySet<string>;
  errors: string[];
}

export function openWorktreeImportForm(ports: ImportPorts) {
  let state: WorktreeImportState = {
    status: "loading",
    worktrees: [],
    selected: new Set(),
    errors: [],
  };
  let closed = false;
  let generation = 0;
  const listeners = new Set<() => void>();
  function publish(next: WorktreeImportState) {
    if (closed) return;
    state = next;
    listeners.forEach((listener) => listener());
  }
  async function refresh() {
    if (closed || state.status === "importing") return;
    const request = ++generation;
    publish({ ...state, status: "loading", errors: [] });
    try {
      const result = await ports.list();
      if (closed || request !== generation) return;
      if (result.error) throw new Error(result.error);
      const selectable = new Set(
        result.worktrees
          .filter((row) => !row.unavailable && (!row.workspaceId || row.archived))
          .map((row) => row.path),
      );
      publish({
        status: "loaded",
        worktrees: result.worktrees,
        selected: new Set([...state.selected].filter((path) => selectable.has(path))),
        errors: [],
      });
    } catch (error) {
      if (request === generation) publish({ ...state, status: "error", errors: [String(error)] });
    }
  }
  return {
    getState: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    close() {
      closed = true;
      generation++;
      listeners.clear();
    },
    refresh,
    toggle(path: string) {
      if (state.status !== "loaded") return;
      const row = state.worktrees.find((entry) => entry.path === path);
      if (!row || row.unavailable || (row.workspaceId && !row.archived)) return;
      const selected = new Set(state.selected);
      if (selected.has(path)) selected.delete(path);
      else selected.add(path);
      publish({ ...state, selected });
    },
    async submit() {
      if (state.status !== "loaded" || !state.selected.size) return;
      const paths = [...state.selected];
      publish({ ...state, status: "importing", errors: [] });
      const errors: string[] = [];
      for (const path of paths) {
        if (closed) break;
        try {
          const result = await ports.import(path);
          if (result.error || !result.workspaceId)
            throw new Error(result.error ?? "Workspace was not returned");
          const selected = new Set(state.selected);
          selected.delete(path);
          publish({
            ...state,
            selected,
            worktrees: state.worktrees.map((row) =>
              row.path === path
                ? { ...row, workspaceId: result.workspaceId, archived: false }
                : row,
            ),
          });
        } catch (error) {
          errors.push(`${path}: ${String(error)}`);
        }
      }
      publish({ ...state, status: "loaded", errors });
    },
  };
}
