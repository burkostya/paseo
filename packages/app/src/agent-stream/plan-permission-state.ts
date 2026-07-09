import { isPermissionPlanItem, type StreamItem } from "@/types/stream";

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
