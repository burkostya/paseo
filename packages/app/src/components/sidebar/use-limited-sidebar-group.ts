import { useCallback, useMemo, useState } from "react";
import {
  selectSidebarGroupVisibility,
  type SidebarGroupVisibilityPolicy,
} from "./sidebar-group-visibility";

const PINNED_POLICY = { kind: "pinned" } as const;

type ExpansionOptions = { expanded?: boolean; onToggleExpanded?: () => void };

export function useLimitedSidebarGroup<T>(
  items: readonly T[],
  policyOrOptions: SidebarGroupVisibilityPolicy<T> | ExpansionOptions = PINNED_POLICY,
  options?: ExpansionOptions,
) {
  const policy = "kind" in policyOrOptions ? policyOrOptions : PINNED_POLICY;
  const expansion = "kind" in policyOrOptions ? options : policyOrOptions;
  const [localExpanded, setExpanded] = useState(false);
  const expanded = expansion?.expanded ?? localExpanded;
  const visibility = useMemo(
    () => selectSidebarGroupVisibility(items, expanded, policy),
    [expanded, items, policy],
  );
  const onToggleExpanded = expansion?.onToggleExpanded;
  const toggleExpanded = useCallback(() => {
    if (onToggleExpanded) onToggleExpanded();
    else setExpanded((current) => !current);
  }, [onToggleExpanded]);

  return { ...visibility, expanded, toggleExpanded };
}
