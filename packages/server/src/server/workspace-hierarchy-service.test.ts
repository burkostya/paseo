import { describe, expect, test } from "vitest";

import {
  collectWorkspaceSubtree,
  inspectWorkspaceSubtree,
  orderWorkspaceSubtree,
  WorkspaceHierarchyBusyError,
  WorkspaceHierarchyOperationCoordinator,
} from "./workspace-hierarchy-service.js";
import { createPersistedWorkspaceRecord } from "./workspace-registry.js";

const NOW = "2026-09-13T00:00:00.000Z";

function workspace(input: {
  workspaceId: string;
  projectId?: string;
  parentWorkspaceId?: string | null;
  archivedAt?: string | null;
}) {
  return createPersistedWorkspaceRecord({
    workspaceId: input.workspaceId,
    projectId: input.projectId ?? "project",
    parentWorkspaceId: input.parentWorkspaceId ?? null,
    cwd: `/tmp/${input.workspaceId}`,
    kind: "directory",
    displayName: input.workspaceId,
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: input.archivedAt ?? null,
  });
}

describe("workspace hierarchy service", () => {
  test("collects only same-project descendants and orders lifecycle work", () => {
    const records = [
      workspace({ workspaceId: "root" }),
      workspace({ workspaceId: "child", parentWorkspaceId: "root" }),
      workspace({ workspaceId: "grandchild", parentWorkspaceId: "child" }),
      workspace({
        workspaceId: "other-project-child",
        projectId: "other",
        parentWorkspaceId: "root",
      }),
    ];

    expect(collectWorkspaceSubtree(records, "root").map((record) => record.workspaceId)).toEqual([
      "root",
      "child",
      "grandchild",
    ]);
    expect(
      orderWorkspaceSubtree(records, "root", "child-first").map((record) => record.workspaceId),
    ).toEqual(["grandchild", "child", "root"]);
  });

  test("reports changing records without losing already archived descendants", () => {
    const records = [
      workspace({ workspaceId: "root" }),
      workspace({ workspaceId: "child", parentWorkspaceId: "root", archivedAt: NOW }),
    ];
    expect(
      inspectWorkspaceSubtree({ records, workspaceId: "root", action: "archive" }),
    ).toMatchObject({
      expectedWorkspaceIds: ["root", "child"],
      changingWorkspaceIds: ["root"],
    });
    expect(
      inspectWorkspaceSubtree({ records, workspaceId: "root", action: "restore" })
        .changingWorkspaceIds,
    ).toEqual(["child"]);
  });

  test("rejects overlapping operations until the first operation settles", async () => {
    const coordinator = new WorkspaceHierarchyOperationCoordinator();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = coordinator.run(["root", "child"], () => held);
    expect(coordinator.isBusy("root")).toBe(true);
    await expect(coordinator.run(["child"], async () => undefined)).rejects.toBeInstanceOf(
      WorkspaceHierarchyBusyError,
    );
    release();
    await first;
    expect(coordinator.isBusy("root")).toBe(false);
    expect(coordinator.isBusy("child")).toBe(false);
  });
});
