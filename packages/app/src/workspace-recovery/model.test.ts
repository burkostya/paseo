import { describe, expect, it } from "vitest";
import { recoverWorkspaceSelection, resolveWorkspaceRecoveryModel } from "./model";

describe("resolveWorkspaceRecoveryModel", () => {
  it("keeps newer recovery actions visible but non-actionable", () => {
    expect(
      resolveWorkspaceRecoveryModel({
        enabled: true,
        connected: true,
        hasClient: true,
        hasServerInfo: true,
        supportsRecovery: true,
        inspection: {
          pending: false,
          error: null,
          data: {
            kind: "recoverable",
            workspaceId: "workspace-1",
            workspaceName: "Feature branch",
            action: "repair_from_snapshot",
            branch: "feature",
          },
        },
        restore: { pending: false, error: null },
      }),
    ).toEqual({
      kind: "unsupportedAction",
      action: "repair_from_snapshot",
    });
  });
});

describe("recoverWorkspaceSelection", () => {
  it("restores the workspace and selected archived agent as one recovery action", async () => {
    const operations: string[] = [];

    await recoverWorkspaceSelection({
      workspaceId: "workspace-1",
      agentId: "agent-1",
      client: {
        restoreWorkspace: async (workspaceId) => {
          operations.push(`workspace:${workspaceId}`);
        },
        refreshAgent: async (agentId) => {
          operations.push(`agent:${agentId}`);
        },
      },
    });

    expect(operations).toEqual(["workspace:workspace-1", "agent:agent-1"]);
  });

  it("restores a hierarchy and reports descendant failures", async () => {
    const operations: string[] = [];

    await expect(
      recoverWorkspaceSelection({
        workspaceId: "workspace-1",
        expectedWorkspaceIds: ["workspace-1", "workspace-2", "workspace-2"],
        client: {
          restoreWorkspace: async () => {
            throw new Error("single restore should not be used");
          },
          restoreWorkspaceSubtree: async (workspaceId, expectedWorkspaceIds) => {
            operations.push(`${workspaceId}:${expectedWorkspaceIds.join(",")}`);
            return {
              accepted: true,
              error: null,
              results: [
                { workspaceId: "workspace-1", status: "succeeded", error: null },
                { workspaceId: "workspace-2", status: "failed", error: "child unavailable" },
              ],
            };
          },
          refreshAgent: async () => undefined,
        },
      }),
    ).resolves.toEqual({ failedWorkspaceIds: ["workspace-2"] });

    expect(operations).toEqual(["workspace-1:workspace-1,workspace-2"]);
  });
});
