import { useCallback, useMemo, useState } from "react";

import { limitSidebarGroupItems, SIDEBAR_GROUP_ITEM_LIMIT } from "./sidebar-group-limit";

export { SIDEBAR_GROUP_ITEM_LIMIT } from "./sidebar-group-limit";

export function useLimitedSidebarGroup<T>(
  items: readonly T[],
  options?: { expanded?: boolean; onToggleExpanded?: () => void },
) {
  const [expanded, setExpanded] = useState(false);
  const isExpanded = options?.expanded ?? expanded;
  const visibleItems = useMemo(
    () => limitSidebarGroupItems(items, isExpanded),
    [isExpanded, items],
  );
  const canToggle = items.length > SIDEBAR_GROUP_ITEM_LIMIT;
  const toggleExpanded = useCallback(() => {
    if (options?.onToggleExpanded) {
      options.onToggleExpanded();
      return;
    }
    setExpanded((current) => !current);
  }, [options]);

  return { visibleItems, expanded: isExpanded, canToggle, toggleExpanded };
}
