import { describe, expect, test } from "vitest";
import {
  buildWorkspaceTreeRows,
  collapsedWorkspaceStatuses,
  collectWorkspaceDescendantKeys,
  limitWorkspaceTreeRows,
} from "./workspace-hierarchy";
import type { SidebarWorkspacePlacement } from "@/hooks/sidebar-workspaces-view-model";

function workspace(
  workspaceId: string,
  parentWorkspaceId: string | null = null,
): SidebarWorkspacePlacement {
  return {
    workspaceKey: `host:${workspaceId}`,
    serverId: "host",
    workspaceId,
    projectViewKey: "project",
    projectName: "Project",
    projectKind: "git",
    workspaceKind: "worktree",
    name: workspaceId,
    parentWorkspaceId,
  };
}

describe("workspace hierarchy projection", () => {
  test("renders a preorder tree and hides descendants of collapsed rows", () => {
    const rows = buildWorkspaceTreeRows({
      workspaces: [workspace("root"), workspace("child", "root"), workspace("grand", "child")],
    });
    expect(rows.map((row) => [row.workspace.workspaceId, row.depth])).toEqual([
      ["root", 0],
      ["child", 1],
      ["grand", 2],
    ]);

    const collapsed = buildWorkspaceTreeRows({
      workspaces: [workspace("root"), workspace("child", "root")],
      collapsedKeys: new Set(["host:root"]),
    });
    expect(collapsed.map((row) => row.workspace.workspaceId)).toEqual(["root"]);
    expect(collapsed[0]?.hasChildren).toBe(true);
    expect(collapsed[0]?.expanded).toBe(false);
  });

  test("promotes malformed cycles and returns descendants", () => {
    const rows = buildWorkspaceTreeRows({
      workspaces: [workspace("a", "b"), workspace("b", "a"), workspace("c", "a")],
    });
    expect(rows).toHaveLength(3);
    expect(rows[0]?.workspace.workspaceId).toBe("a");
    expect(rows[0]?.depth).toBe(0);
    expect(collectWorkspaceDescendantKeys([workspace("a"), workspace("b", "a")], "host:a")).toEqual(
      new Set(["host:b"]),
    );
  });

  test("keeps active rows and their ancestors beyond the initial visible rows", () => {
    const rows = buildWorkspaceTreeRows({
      workspaces: [
        workspace("one"),
        workspace("two"),
        workspace("three"),
        workspace("four"),
        workspace("five"),
        workspace("six"),
        workspace("seven"),
        workspace("parent"),
        workspace("child", "parent"),
        workspace("quiet"),
      ],
    });
    const visible = limitWorkspaceTreeRows(rows, 7, (key) =>
      key === "host:child" ? "running" : "done",
    );
    expect(visible.map((row) => row.workspace.workspaceId)).toEqual([
      "one",
      "two",
      "three",
      "four",
      "five",
      "six",
      "seven",
      "parent",
      "child",
    ]);
  });

  test("a collapsed parent carries the most urgent hidden descendant status", () => {
    const workspaces = [workspace("root"), workspace("child", "root"), workspace("grand", "child")];
    const allRows = buildWorkspaceTreeRows({ workspaces });
    const collapsed = buildWorkspaceTreeRows({ workspaces, collapsedKeys: new Set(["host:root"]) });
    const entries = new Map([
      ["host:root", { statusBucket: "done" as const }],
      ["host:child", { statusBucket: "running" as const }],
      ["host:grand", { statusBucket: "needs_input" as const }],
    ]);
    expect(collapsedWorkspaceStatuses(collapsed, allRows, entries)).toEqual(
      new Map([["host:root", "needs_input"]]),
    );
  });
});
