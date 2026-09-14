import { describe, expect, test } from "vitest";
import type { SidebarWorkspacePlacement } from "@/hooks/sidebar-workspaces-view-model";
import { buildWorkspaceTreeRows } from "./workspace-hierarchy";
import { resolveWorkspaceTreeDrop, resolveWorkspaceTreeDropZone } from "./workspace-tree-dnd";

function workspace(id: string, parentWorkspaceId: string | null = null): SidebarWorkspacePlacement {
  return {
    workspaceKey: `host:${id}`,
    serverId: "host",
    workspaceId: id,
    projectViewKey: "project",
    projectName: "Project",
    projectKind: "git",
    workspaceKind: "worktree",
    name: id,
    parentWorkspaceId,
  };
}

describe("workspace tree drag intent", () => {
  const rows = buildWorkspaceTreeRows({
    workspaces: [
      workspace("a"),
      workspace("b", "a"),
      workspace("c", "b"),
      workspace("d"),
      workspace("e"),
    ],
  });

  test("rejects dropping a parent into its descendant", () => {
    const result = resolveWorkspaceTreeDrop({
      rows,
      draggedWorkspaceKey: "host:a",
      intent: { kind: "inside", targetWorkspaceKey: "host:c" },
    });
    expect(result.accepted).toBe(false);
    expect(result.reason).toBe("descendant_target");
  });

  test("resolves inside and root drops", () => {
    const inside = resolveWorkspaceTreeDrop({
      rows,
      draggedWorkspaceKey: "host:e",
      intent: { kind: "inside", targetWorkspaceKey: "host:b" },
    });
    expect(inside.parentWorkspaceId).toBe("b");
    const root = resolveWorkspaceTreeDrop({
      rows,
      draggedWorkspaceKey: "host:b",
      intent: { kind: "root" },
    });
    expect(root.parentWorkspaceId).toBeNull();
  });

  test("uses the upper and lower row quarters for sibling drops", () => {
    expect(
      resolveWorkspaceTreeDropZone({
        activeTop: 0,
        activeHeight: 10,
        targetTop: 20,
        targetHeight: 40,
        targetWorkspaceKey: "host:a",
      }).kind,
    ).toBe("before");
    expect(
      resolveWorkspaceTreeDropZone({
        activeTop: 50,
        activeHeight: 10,
        targetTop: 20,
        targetHeight: 40,
        targetWorkspaceKey: "host:a",
      }).kind,
    ).toBe("after");
  });
});
