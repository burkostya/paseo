import type { ActiveWorkspaceSelection } from "@/stores/last-workspace-selection";

export const WORKSPACE_NAVIGATION_HISTORY_STORAGE_KEY = "paseo:workspace-navigation-history";

const WORKSPACE_NAVIGATION_HISTORY_VERSION = 1;

export interface WorkspaceNavigationHistoryStorage {
  read(): Promise<string | null>;
  write(value: string): Promise<void>;
}

export interface WorkspaceNavigationCycleInput {
  current: ActiveWorkspaceSelection | null;
  delta: 1 | -1;
  isAvailable: (selection: ActiveWorkspaceSelection) => boolean;
}

interface WorkspaceNavigationCycle {
  snapshot: ActiveWorkspaceSelection[];
  index: number;
  previewed: ActiveWorkspaceSelection[];
}

interface PendingCycleObservations {
  finalSelection: ActiveWorkspaceSelection;
  previewed: ActiveWorkspaceSelection[];
}

function normalizeSelection(input: unknown): ActiveWorkspaceSelection | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return null;
  }
  const record = input as Record<string, unknown>;
  const serverId = typeof record.serverId === "string" ? record.serverId.trim() : "";
  const workspaceId = typeof record.workspaceId === "string" ? record.workspaceId.trim() : "";
  if (!serverId || !workspaceId) {
    return null;
  }
  return { serverId, workspaceId };
}

function selectionsEqual(left: ActiveWorkspaceSelection, right: ActiveWorkspaceSelection): boolean {
  return left.serverId === right.serverId && left.workspaceId === right.workspaceId;
}

function includesSelection(
  selections: readonly ActiveWorkspaceSelection[],
  target: ActiveWorkspaceSelection,
): boolean {
  return selections.some((selection) => selectionsEqual(selection, target));
}

export function normalizeWorkspaceNavigationHistory(input: unknown): ActiveWorkspaceSelection[] {
  if (!Array.isArray(input)) {
    return [];
  }
  const history: ActiveWorkspaceSelection[] = [];
  for (const candidate of input) {
    const selection = normalizeSelection(candidate);
    if (!selection || includesSelection(history, selection)) {
      continue;
    }
    history.push(selection);
  }
  return history;
}

export function recordWorkspaceNavigationVisit(
  history: readonly ActiveWorkspaceSelection[],
  selection: ActiveWorkspaceSelection,
): ActiveWorkspaceSelection[] {
  const normalized = normalizeSelection(selection);
  if (!normalized) {
    return [...history];
  }
  return [normalized, ...history.filter((candidate) => !selectionsEqual(candidate, normalized))];
}

function parsePersistedHistory(stored: string | null): ActiveWorkspaceSelection[] {
  if (!stored) {
    return [];
  }
  try {
    const parsed = JSON.parse(stored) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return [];
    }
    const record = parsed as Record<string, unknown>;
    if (record.version !== WORKSPACE_NAVIGATION_HISTORY_VERSION) {
      return [];
    }
    return normalizeWorkspaceNavigationHistory(record.history);
  } catch {
    return [];
  }
}

function serializeHistory(history: readonly ActiveWorkspaceSelection[]): string {
  return JSON.stringify({
    version: WORKSPACE_NAVIGATION_HISTORY_VERSION,
    history,
  });
}

function wrapIndex(index: number, length: number): number {
  return (index + length) % length;
}

export function createWorkspaceNavigationHistoryStore(storage: WorkspaceNavigationHistoryStorage) {
  let history: ActiveWorkspaceSelection[] = [];
  let cycle: WorkspaceNavigationCycle | null = null;
  let pendingCycleObservations: PendingCycleObservations | null = null;
  let hydrated = false;
  let hydrationPromise: Promise<void> | null = null;

  function persistHistory(): void {
    if (!hydrated) {
      return;
    }
    void storage.write(serializeHistory(history)).catch(() => {});
  }

  function hydrate(): Promise<void> {
    if (hydrationPromise) {
      return hydrationPromise;
    }
    hydrationPromise = storage
      .read()
      .then((stored) => {
        const persistedHistory = parsePersistedHistory(stored);
        history = normalizeWorkspaceNavigationHistory([...history, ...persistedHistory]);
        return undefined;
      })
      .catch(() => {})
      .finally(() => {
        hydrated = true;
        persistHistory();
      });
    return hydrationPromise;
  }

  function observe(selection: ActiveWorkspaceSelection): void {
    const normalized = normalizeSelection(selection);
    if (!normalized) {
      return;
    }

    if (cycle && includesSelection(cycle.previewed, normalized)) {
      return;
    }

    if (pendingCycleObservations) {
      if (includesSelection(pendingCycleObservations.previewed, normalized)) {
        if (selectionsEqual(pendingCycleObservations.finalSelection, normalized)) {
          pendingCycleObservations = null;
        }
        return;
      }
      pendingCycleObservations = null;
    }

    const nextHistory = recordWorkspaceNavigationVisit(history, normalized);
    if (
      nextHistory.length === history.length &&
      nextHistory.every((candidate, index) => selectionsEqual(candidate, history[index]!))
    ) {
      return;
    }
    history = nextHistory;
    persistHistory();
  }

  function advance(input: WorkspaceNavigationCycleInput): ActiveWorkspaceSelection | null {
    if (!cycle) {
      const availableHistory = history.filter(input.isAvailable);
      const current =
        input.current && input.isAvailable(input.current)
          ? input.current
          : (availableHistory[0] ?? null);
      if (!current) {
        return null;
      }
      const snapshot = [
        current,
        ...availableHistory.filter((selection) => !selectionsEqual(selection, current)),
      ];
      if (snapshot.length < 2) {
        return null;
      }
      cycle = { snapshot, index: 0, previewed: [] };
    }

    cycle.index = wrapIndex(cycle.index + input.delta, cycle.snapshot.length);
    const target = cycle.snapshot[cycle.index] ?? null;
    if (!target) {
      return null;
    }
    if (!includesSelection(cycle.previewed, target)) {
      cycle.previewed.push(target);
    }
    return target;
  }

  function commitCycle(): ActiveWorkspaceSelection | null {
    if (!cycle) {
      return null;
    }
    const selected = cycle.snapshot[cycle.index] ?? cycle.snapshot[0] ?? null;
    const previewed = cycle.previewed;
    cycle = null;
    if (!selected) {
      return null;
    }

    history = recordWorkspaceNavigationVisit(history, selected);
    pendingCycleObservations = {
      finalSelection: selected,
      previewed,
    };
    persistHistory();
    return selected;
  }

  return {
    advance,
    commitCycle,
    getHistory: () => history,
    hydrate,
    isCycling: () => cycle !== null,
    isHydrated: () => hydrated,
    observe,
  };
}
