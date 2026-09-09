import {
  isAgentToolCallItem,
  isPermissionPlanItem,
  type PermissionPlanItem,
  type StreamItem,
} from "@/types/stream";
import type {
  AgentPermissionRequest,
  AgentPermissionResponse,
} from "@getpaseo/protocol/agent-types";

export type PlanPermissionResolutionStatus = "approved" | "rejected" | "skipped";

const PLAN_PERMISSION_RESOLUTION_STATUSES: ReadonlySet<PlanPermissionResolutionStatus> = new Set([
  "approved",
  "rejected",
  "skipped",
]);

export interface PlanPermissionProjection {
  tail: StreamItem[];
  head: StreamItem[];
}

interface PlanTimelineResult {
  key: string;
  item: Extract<StreamItem, { kind: "tool_call" }>;
  provider: AgentPermissionRequest["provider"];
  requestId: string;
  planText: string;
  metadata: Record<string, unknown> | undefined;
}

function planPermissionKey(
  provider: AgentPermissionRequest["provider"],
  requestId: string,
): string {
  return `${provider}:${requestId}`;
}

function getPlanTimelineResult(item: StreamItem): PlanTimelineResult | null {
  if (!isAgentToolCallItem(item)) {
    return null;
  }

  const { data } = item.payload;
  const normalizedName = data.name
    .trim()
    .replace(/[.\s-]+/g, "_")
    .toLowerCase();
  if (normalizedName !== "plan_approval" || data.detail.type !== "plan") {
    return null;
  }

  return {
    key: planPermissionKey(data.provider, data.callId),
    item,
    provider: data.provider,
    requestId: data.callId,
    planText: data.detail.text,
    metadata: data.metadata,
  };
}

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

function resolutionForPlanTimelineResult(
  result: PlanTimelineResult,
): AgentPermissionResponse | undefined {
  const status = resolvePlanTimelineResolutionStatus(result.metadata);
  if (!status) {
    return undefined;
  }

  if (status === "approved") {
    return {
      behavior: "allow",
      selectedActionId:
        typeof result.metadata?.actionId === "string" ? result.metadata.actionId : "implement",
    };
  }

  const response: Extract<AgentPermissionResponse, { behavior: "deny" }> = {
    behavior: "deny",
    selectedActionId: status === "skipped" ? "superseded" : "reject",
  };
  if (status === "skipped") {
    response.message = "Superseded by a later prompt.";
  } else if (typeof result.metadata?.message === "string") {
    response.message = result.metadata.message;
  }
  return response;
}

function planRequestFromTimelineResult(result: PlanTimelineResult): AgentPermissionRequest {
  return {
    id: result.requestId,
    provider: result.provider,
    name: "plan_approval",
    kind: "plan",
    input: { plan: result.planText },
    metadata: {
      planText: result.planText,
      ...result.metadata,
    },
  };
}

function mergePlanTimelineResultIntoPermission(
  existing: PermissionPlanItem,
  result: PlanTimelineResult,
  resolution: AgentPermissionResponse | undefined,
): PermissionPlanItem {
  const resultCursor = result.item.timelineCursor;
  const cursorChanged =
    resultCursor !== undefined &&
    (existing.timelineCursor?.epoch !== resultCursor.epoch ||
      existing.timelineCursor?.seq !== resultCursor.seq);
  const turnChanged = result.item.turnId !== undefined && existing.turnId !== result.item.turnId;
  const resultStatus = resolution ? resolvePlanPermissionResolutionStatus(resolution) : null;
  const existingStatus = resolvePlanPermissionResolutionStatus(existing.resolution);
  const resolutionChanged =
    resolution !== undefined && (!existing.resolution || existingStatus !== resultStatus);

  if (!cursorChanged && !turnChanged && !resolutionChanged) {
    return existing;
  }

  return {
    ...existing,
    ...(cursorChanged && resultCursor ? { timelineCursor: resultCursor } : {}),
    ...(turnChanged ? { turnId: result.item.turnId } : {}),
    ...(resolutionChanged && resolution ? { resolution } : {}),
  };
}

function projectPlanPermissionLane(
  items: StreamItem[],
  planItemsByKey: ReadonlyMap<string, PermissionPlanItem>,
  resultsByKey: ReadonlyMap<string, PlanTimelineResult>,
  resolvedPlanItemsByKey: ReadonlyMap<string, PermissionPlanItem>,
  seenTimelineResults: Set<string>,
): { items: StreamItem[]; changed: boolean } {
  let changed = false;
  const next: StreamItem[] = [];

  for (const item of items) {
    if (isPermissionPlanItem(item)) {
      const resolved = resolvedPlanItemsByKey.get(
        planPermissionKey(item.request.provider, item.request.id),
      );
      if (resolved && resolved !== item) {
        next.push(resolved);
        changed = true;
      } else {
        next.push(item);
      }
      continue;
    }

    const rawResult = getPlanTimelineResult(item);
    if (!rawResult) {
      next.push(item);
      continue;
    }
    const result = resultsByKey.get(rawResult.key) ?? rawResult;

    const existing = planItemsByKey.get(result.key);
    const resolution = resolutionForPlanTimelineResult(result);
    if (!existing && !resolution) {
      // Unknown legacy metadata cannot safely be turned into a resolved card.
      // Leave the durable tool row visible until a later event provides a status.
      next.push(item);
      continue;
    }

    if (seenTimelineResults.has(result.key)) {
      changed = true;
      continue;
    }
    seenTimelineResults.add(result.key);

    if (existing) {
      // Keep an unresolved plan timeline row until its persisted metadata tells us
      // how it was resolved. Once the result is known, the permission card owns
      // the row and the raw plan_approval tool call is presentation-only.
      if (existing.resolution || resolution) {
        changed = true;
        continue;
      }
      next.push(item);
      continue;
    }

    // History can contain the result without the live permission request. Rebuild
    // the same card shape so reopening a session still shows one readable plan.
    const fallback: PermissionPlanItem = {
      kind: "permission_plan",
      id: `permission_plan_${result.requestId}`,
      ...(result.item.timelineCursor ? { timelineCursor: result.item.timelineCursor } : {}),
      ...(result.item.turnId ? { turnId: result.item.turnId } : {}),
      timestamp: result.item.timestamp,
      request: planRequestFromTimelineResult(result),
      ...(resolution ? { resolution } : {}),
    };
    next.push(fallback);
    changed = true;
  }

  return { items: changed ? next : items, changed };
}

/**
 * Coalesce the permission card with the plan_approval timeline result emitted
 * when the user rejects, skips, or accepts a plan. The permission request is
 * the display anchor; the tool call is a durable result used for hydration.
 */
export function projectPlanPermissionItems(input: {
  tail: StreamItem[];
  head: StreamItem[];
}): PlanPermissionProjection {
  const allItems = [...input.tail, ...input.head];
  const planItemsByKey = new Map<string, PermissionPlanItem>();
  const resultsByKey = new Map<string, PlanTimelineResult>();

  for (const item of allItems) {
    if (isPermissionPlanItem(item)) {
      planItemsByKey.set(planPermissionKey(item.request.provider, item.request.id), item);
      continue;
    }
    const result = getPlanTimelineResult(item);
    if (result) {
      const previous = resultsByKey.get(result.key);
      if (
        !previous ||
        (!resolutionForPlanTimelineResult(previous) && resolutionForPlanTimelineResult(result))
      ) {
        resultsByKey.set(result.key, result);
      }
    }
  }

  if (resultsByKey.size === 0) {
    return { tail: input.tail, head: input.head };
  }

  const resolvedPlanItemsByKey = new Map<string, PermissionPlanItem>();
  for (const [key, existing] of planItemsByKey) {
    const result = resultsByKey.get(key);
    if (!result) continue;
    const resolution = resolutionForPlanTimelineResult(result);
    if (!resolution && !existing.resolution) continue;
    resolvedPlanItemsByKey.set(
      key,
      mergePlanTimelineResultIntoPermission(existing, result, resolution),
    );
  }

  const seenTimelineResults = new Set<string>();
  const projectedTail = projectPlanPermissionLane(
    input.tail,
    planItemsByKey,
    resultsByKey,
    resolvedPlanItemsByKey,
    seenTimelineResults,
  );
  const projectedHead = projectPlanPermissionLane(
    input.head,
    planItemsByKey,
    resultsByKey,
    resolvedPlanItemsByKey,
    seenTimelineResults,
  );

  return {
    tail: projectedTail.items,
    head: projectedHead.items,
  };
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
