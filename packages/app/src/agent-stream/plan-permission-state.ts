import { isPermissionPlanItem, type StreamItem } from "@/types/stream";
import type { AgentPermissionResponse } from "@getpaseo/protocol/agent-types";

export type PlanPermissionResolutionStatus = "approved" | "rejected" | "skipped";

const PLAN_PERMISSION_RESOLUTION_STATUSES: ReadonlySet<PlanPermissionResolutionStatus> = new Set([
  "approved",
  "rejected",
  "skipped",
]);

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

export function resolvePlanTimelineResolutionStatus(
  metadata: Record<string, unknown> | undefined,
): PlanPermissionResolutionStatus | null {
  const planResolution = metadata?.planResolution;
  if (
    typeof planResolution === "string" &&
    PLAN_PERMISSION_RESOLUTION_STATUSES.has(planResolution as PlanPermissionResolutionStatus)
  ) {
    return planResolution as PlanPermissionResolutionStatus;
  }

  // Claude emitted actionId before planResolution was persisted. Keep those
  // historical superseded plans labelled without guessing ordinary denials.
  return metadata?.actionId === "superseded" ? "skipped" : null;
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
