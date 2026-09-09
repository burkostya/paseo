import { describe, expect, it } from "vitest";
import type { StreamItem } from "@/types/stream";
import {
  collectSupersededPlanPermissionRequestIds,
  projectPlanPermissionItems,
  resolvePlanPermissionResolutionStatus,
  resolvePlanTimelineResolutionStatus,
} from "./plan-permission-state";

const timestamp = new Date(0);

type PermissionPlanStreamItem = Extract<StreamItem, { kind: "permission_plan" }>;

function plan(
  id: string,
  resolution?: PermissionPlanStreamItem["resolution"],
  planText = id,
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
      input: { plan: planText },
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

function planTimelineResult(
  id: string,
  planText: string,
  planResolution: "approved" | "rejected" | "skipped",
): Extract<StreamItem, { kind: "tool_call" }> {
  return {
    kind: "tool_call",
    id: `timeline_${id}`,
    timestamp,
    payload: {
      source: "agent",
      data: {
        provider: "codex",
        callId: id,
        name: "plan_approval",
        status: "completed",
        error: null,
        detail: { type: "plan", text: planText },
        metadata: { approved: planResolution === "approved", planResolution },
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

describe("resolvePlanTimelineResolutionStatus", () => {
  it("reads persisted statuses and the legacy Claude superseded action", () => {
    expect(resolvePlanTimelineResolutionStatus(undefined)).toBeNull();
    expect(resolvePlanTimelineResolutionStatus({ approved: false })).toBeNull();
    expect(resolvePlanTimelineResolutionStatus({ planResolution: "approved" })).toBe("approved");
    expect(resolvePlanTimelineResolutionStatus({ planResolution: "rejected" })).toBe("rejected");
    expect(resolvePlanTimelineResolutionStatus({ planResolution: "skipped" })).toBe("skipped");
    expect(resolvePlanTimelineResolutionStatus({ actionId: "superseded" })).toBe("skipped");
  });

  it("does not trust unknown persisted values", () => {
    expect(resolvePlanTimelineResolutionStatus({ planResolution: "dismissed" })).toBeNull();
    expect(resolvePlanTimelineResolutionStatus({ actionId: "reject" })).toBeNull();
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

describe("projectPlanPermissionItems", () => {
  it("keeps the original card in place when a skipped timeline result arrives", () => {
    const timelineResult = planTimelineResult("plan-1", "Do the work", "skipped");
    timelineResult.timelineCursor = { epoch: "epoch-1", seq: 42 };
    const result = projectPlanPermissionItems({
      tail: [plan("plan-1"), userMessage("u1")],
      head: [timelineResult],
    });

    expect(result.tail.map((item) => item.kind)).toEqual(["permission_plan", "user_message"]);
    expect(result.head).toEqual([]);
    expect(result.tail[0]).toMatchObject({
      kind: "permission_plan",
      request: { id: "plan-1" },
      timelineCursor: { epoch: "epoch-1", seq: 42 },
      resolution: { behavior: "deny", selectedActionId: "superseded" },
    });
  });

  it("hydrates a plan card when only the persisted result is available", () => {
    const result = projectPlanPermissionItems({
      tail: [planTimelineResult("plan-1", "Do the work", "rejected")],
      head: [],
    });

    expect(result.tail).toHaveLength(1);
    expect(result.tail[0]).toMatchObject({
      kind: "permission_plan",
      id: "permission_plan_plan-1",
      request: { id: "plan-1", input: { plan: "Do the work" } },
      resolution: { behavior: "deny", selectedActionId: "reject" },
    });
  });

  it("keeps plans with equal text distinct by request id", () => {
    const result = projectPlanPermissionItems({
      tail: [plan("plan-1", undefined, "same plan"), plan("plan-2", undefined, "same plan")],
      head: [planTimelineResult("plan-1", "same plan", "skipped")],
    });

    expect(result.tail).toHaveLength(2);
    expect(
      result.tail.map((item) => (item.kind === "permission_plan" ? item.request.id : "")),
    ).toEqual(["plan-1", "plan-2"]);
    expect(result.tail[0]).toMatchObject({
      resolution: { behavior: "deny", selectedActionId: "superseded" },
    });
    expect(result.tail[1]).not.toHaveProperty("resolution");
  });

  it("deduplicates repeated timeline results across history and the live head", () => {
    const repeated = planTimelineResult("plan-1", "Do the work", "skipped");
    const result = projectPlanPermissionItems({
      tail: [repeated],
      head: [repeated],
    });

    expect(result.tail).toHaveLength(1);
    expect(result.head).toEqual([]);
  });
});
