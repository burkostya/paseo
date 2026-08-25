import { describe, expect, it } from "vitest";
import type { ActiveWorkspaceSelection } from "@/stores/last-workspace-selection";
import {
  createWorkspaceNavigationHistoryStore,
  normalizeWorkspaceNavigationHistory,
  type WorkspaceNavigationHistoryStorage,
} from "./workspace-navigation-history";

function workspace(workspaceId: string, serverId = "server"): ActiveWorkspaceSelection {
  return { serverId, workspaceId };
}

class MemoryHistoryStorage implements WorkspaceNavigationHistoryStorage {
  public value: string | null;

  public constructor(value: string | null = null) {
    this.value = value;
  }

  async read(): Promise<string | null> {
    return this.value;
  }

  async write(value: string): Promise<void> {
    this.value = value;
  }
}

function persistedHistory(...selections: ActiveWorkspaceSelection[]): string {
  return JSON.stringify({ version: 1, history: selections });
}

const available = () => true;

describe("workspace navigation history", () => {
  it("normalizes malformed and duplicate persisted selections", () => {
    expect(
      normalizeWorkspaceNavigationHistory([
        workspace("A"),
        { serverId: " server ", workspaceId: "A" },
        { serverId: "", workspaceId: "missing-host" },
        null,
        workspace("B", "other"),
      ]),
    ).toEqual([workspace("A"), workspace("B", "other")]);
  });

  it("records visits in cross-host MRU order and persists them", async () => {
    const storage = new MemoryHistoryStorage();
    const store = createWorkspaceNavigationHistoryStore(storage);
    await store.hydrate();

    store.observe(workspace("A", "host-a"));
    store.observe(workspace("B", "host-b"));
    store.observe(workspace("A", "host-a"));

    expect(store.getHistory()).toEqual([workspace("A", "host-a"), workspace("B", "host-b")]);
    expect(JSON.parse(storage.value ?? "null")).toEqual({
      version: 1,
      history: [workspace("A", "host-a"), workspace("B", "host-b")],
    });
  });

  it("merges an observation made before hydration ahead of persisted history", async () => {
    const storage = new MemoryHistoryStorage(
      persistedHistory(workspace("A"), workspace("B"), workspace("C")),
    );
    const store = createWorkspaceNavigationHistoryStore(storage);

    store.observe(workspace("X"));
    await store.hydrate();

    expect(store.getHistory()).toEqual([
      workspace("X"),
      workspace("A"),
      workspace("B"),
      workspace("C"),
    ]);
  });

  it("keeps a frozen cycle and commits only the final selection", async () => {
    const store = createWorkspaceNavigationHistoryStore(
      new MemoryHistoryStorage(
        persistedHistory(workspace("A"), workspace("B"), workspace("C"), workspace("D")),
      ),
    );
    await store.hydrate();

    expect(store.advance({ current: workspace("A"), delta: 1, isAvailable: available })).toEqual(
      workspace("B"),
    );
    store.observe(workspace("B"));
    expect(store.advance({ current: workspace("B"), delta: 1, isAvailable: available })).toEqual(
      workspace("C"),
    );
    store.observe(workspace("C"));

    expect(store.commitCycle()).toEqual(workspace("C"));
    expect(store.getHistory()).toEqual([
      workspace("C"),
      workspace("A"),
      workspace("B"),
      workspace("D"),
    ]);
  });

  it("moves backward and wraps within the same frozen cycle", async () => {
    const store = createWorkspaceNavigationHistoryStore(
      new MemoryHistoryStorage(persistedHistory(workspace("A"), workspace("B"), workspace("C"))),
    );
    await store.hydrate();

    expect(store.advance({ current: workspace("A"), delta: -1, isAvailable: available })).toEqual(
      workspace("C"),
    );
    expect(store.advance({ current: workspace("C"), delta: 1, isAvailable: available })).toEqual(
      workspace("A"),
    );
  });

  it("skips unavailable entries and does nothing with fewer than two targets", async () => {
    const store = createWorkspaceNavigationHistoryStore(
      new MemoryHistoryStorage(
        persistedHistory(workspace("A"), workspace("removed"), workspace("B")),
      ),
    );
    await store.hydrate();
    const isAvailable = (selection: ActiveWorkspaceSelection) =>
      selection.workspaceId !== "removed" && selection.workspaceId !== "B";

    expect(store.advance({ current: workspace("A"), delta: 1, isAvailable })).toBeNull();
    expect(store.isCycling()).toBe(false);
  });

  it("ignores delayed preview observations after commit", async () => {
    const store = createWorkspaceNavigationHistoryStore(
      new MemoryHistoryStorage(
        persistedHistory(workspace("A"), workspace("B"), workspace("C"), workspace("D")),
      ),
    );
    await store.hydrate();

    store.advance({ current: workspace("A"), delta: 1, isAvailable: available });
    store.advance({ current: workspace("B"), delta: 1, isAvailable: available });
    store.commitCycle();
    store.observe(workspace("B"));
    store.observe(workspace("C"));

    expect(store.getHistory()).toEqual([
      workspace("C"),
      workspace("A"),
      workspace("B"),
      workspace("D"),
    ]);
  });
});
