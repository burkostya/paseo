export const SIDEBAR_GROUP_ITEM_LIMIT = 20;

export function limitSidebarGroupItems<T>(items: readonly T[], expanded: boolean): T[] {
  return expanded ? [...items] : items.slice(0, SIDEBAR_GROUP_ITEM_LIMIT);
}
