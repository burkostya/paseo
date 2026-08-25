import { describe, expect, it } from "vitest";
import type { StreamItem } from "@/types/stream";
import {
  collectSupersededPlanPermissionRequestIds,
  resolvePlanPermissionResolutionStatus,
} from "./plan-permission-state";

const timestamp = new Date(0);

type PermissionPlanStreamItem = Extract<StreamItem, { kind: "permission_plan" }>;

function plan(
  id: string,
  resolution?: PermissionPlanStreamItem["resolution"],
): PermissionPlanStreamItem {
  return {
    kind: "permission_plan",
    id: `permission_plan_${id}`,
    timestamp,
    request: {
      id,
      provider: "codex",
      name: "CodexPlanApproval",
      kind: "plan",
    },
    ...(resolution ? { resolution } : {}),
  };
}

function userMessage(id: string): Extract<StreamItem, { kind: "user_message" }> {
  return {
    kind: "user_message",
    id,
    text: id,
    timestamp,
  };
}

function assistantMessage(id: string): Extract<StreamItem, { kind: "assistant_message" }> {
  return {
    kind: "assistant_message",
    id,
    text: id,
    timestamp,
  };
}

function toolCall(id: string): Extract<StreamItem, { kind: "tool_call" }> {
  return {
    kind: "tool_call",
    id,
    timestamp,
    payload: {
      source: "orchestrator",
      data: {
        toolCallId: id,
        toolName: "Shell",
        arguments: "echo hi",
        status: "completed",
      },
    },
  };
}

describe("resolvePlanPermissionResolutionStatus", () => {
  it("distinguishes approved, rejected, and superseded plans", () => {
    expect(resolvePlanPermissionResolutionStatus(undefined)).toBeNull();
    expect(resolvePlanPermissionResolutionStatus({ behavior: "allow" })).toBe("approved");
    expect(resolvePlanPermissionResolutionStatus({ behavior: "deny" })).toBe("rejected");
    expect(
      resolvePlanPermissionResolutionStatus({
        behavior: "deny",
        selectedActionId: "superseded",
        message: "Superseded by a later prompt.",
      }),
    ).toBe("skipped");
  });
});

describe("collectSupersededPlanPermissionRequestIds", () => {
  it("marks an unresolved plan when a later user message exists", () => {
    const ids = collectSupersededPlanPermissionRequestIds({
      tail: [plan("plan-1"), userMessage("u1")],
      head: [],
    });

    expect([...ids]).toEqual(["plan-1"]);
  });

  it("marks an unresolved plan when a later assistant message is in head", () => {
    const ids = collectSupersededPlanPermissionRequestIds({
      tail: [plan("plan-1")],
      head: [assistantMessage("a1")],
    });

    expect([...ids]).toEqual(["plan-1"]);
  });

  it("does not mark plans followed only by tool events", () => {
    const ids = collectSupersededPlanPermissionRequestIds({
      tail: [plan("plan-1"), toolCall("tool-1")],
      head: [],
    });

    expect([...ids]).toEqual([]);
  });

  it("does not mark already resolved plans", () => {
    const ids = collectSupersededPlanPermissionRequestIds({
      tail: [plan("plan-1", { behavior: "deny" }), userMessage("u1")],
      head: [],
    });

    expect([...ids]).toEqual([]);
  });
});
