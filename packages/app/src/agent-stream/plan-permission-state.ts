import { isPermissionPlanItem, type StreamItem } from "@/types/stream";
import type { AgentPermissionResponse } from "@getpaseo/protocol/agent-types";

export type PlanPermissionResolutionStatus = "approved" | "rejected" | "skipped";

export function resolvePlanPermissionResolutionStatus(
  resolution: AgentPermissionResponse | undefined,
): PlanPermissionResolutionStatus | null {
  if (!resolution) {
    return null;
  }
  if (resolution.behavior === "allow") {
    return "approved";
  }
  return resolution.selectedActionId === "superseded" ? "skipped" : "rejected";
}

export function collectSupersededPlanPermissionRequestIds(input: {
  tail: StreamItem[];
  head: StreamItem[];
}): Set<string> {
  const superseded = new Set<string>();
  const openPlans = new Set<string>();

  for (const item of [...input.tail, ...input.head]) {
    if (isPermissionPlanItem(item)) {
      if (!item.resolution) {
        openPlans.add(item.request.id);
      }
      continue;
    }

    if (item.kind !== "user_message" && item.kind !== "assistant_message") {
      continue;
    }

    for (const requestId of openPlans) {
      superseded.add(requestId);
    }
  }

  return superseded;
}
