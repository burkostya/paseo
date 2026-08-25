import type { StreamItem } from "@/types/stream";

export interface ComposerHistoryEntry {
  id: string;
  text: string;
}

export interface ComposerHistorySelection {
  start: number;
  end: number;
}

export type ComposerHistoryDirection = "older" | "newer";

export interface ComposerHistoryNavigationState {
  selectedIndex: number | null;
  draftBeforeNavigation: string;
}

export interface ComposerHistoryNavigationResult {
  state: ComposerHistoryNavigationState;
  value: string;
}

export const initialComposerHistoryNavigationState: ComposerHistoryNavigationState = {
  selectedIndex: null,
  draftBeforeNavigation: "",
};

interface OrderedStreamItem {
  item: StreamItem;
  ordinal: number;
}

export function buildComposerHistoryEntries(input: {
  head: readonly StreamItem[];
  tail: readonly StreamItem[];
}): ComposerHistoryEntry[] {
  const orderedItems: OrderedStreamItem[] = [...input.head, ...input.tail].map((item, ordinal) => ({
    item,
    ordinal,
  }));
  orderedItems.sort((left, right) => {
    const timestampDelta = left.item.timestamp.getTime() - right.item.timestamp.getTime();
    return timestampDelta === 0 ? left.ordinal - right.ordinal : timestampDelta;
  });

  const entries: ComposerHistoryEntry[] = [];
  for (const { item } of orderedItems) {
    if (item.kind !== "user_message") {
      continue;
    }
    if (item.text.trim().length === 0) {
      continue;
    }
    if (entries.at(-1)?.text === item.text) {
      continue;
    }
    entries.push({
      id: item.id,
      text: item.text,
    });
  }
  return entries;
}

export function getComposerHistoryNavigationResult(input: {
  state: ComposerHistoryNavigationState;
  entries: readonly ComposerHistoryEntry[];
  draft: string;
  direction: ComposerHistoryDirection;
}): ComposerHistoryNavigationResult | null {
  if (input.entries.length === 0) {
    return null;
  }

  if (input.direction === "older") {
    const selectedIndex =
      input.state.selectedIndex === null
        ? input.entries.length - 1
        : Math.max(0, input.state.selectedIndex - 1);
    const entry = input.entries[selectedIndex];
    if (!entry) {
      return null;
    }
    return {
      state: {
        selectedIndex,
        draftBeforeNavigation:
          input.state.selectedIndex === null ? input.draft : input.state.draftBeforeNavigation,
      },
      value: entry.text,
    };
  }

  if (input.state.selectedIndex === null) {
    return null;
  }

  if (input.state.selectedIndex >= input.entries.length - 1) {
    return {
      state: initialComposerHistoryNavigationState,
      value: input.state.draftBeforeNavigation,
    };
  }

  const selectedIndex = input.state.selectedIndex + 1;
  const entry = input.entries[selectedIndex];
  if (!entry) {
    return null;
  }
  return {
    state: {
      selectedIndex,
      draftBeforeNavigation: input.state.draftBeforeNavigation,
    },
    value: entry.text,
  };
}

export function shouldNavigateComposerHistory(input: {
  key: string;
  selection: ComposerHistorySelection;
  valueLength: number;
  isNavigating: boolean;
}): input is {
  key: "ArrowUp" | "ArrowDown";
  selection: ComposerHistorySelection;
  valueLength: number;
  isNavigating: boolean;
} {
  if (input.key !== "ArrowUp" && input.key !== "ArrowDown") {
    return false;
  }
  if (input.selection.start !== input.selection.end) {
    return false;
  }
  if (input.isNavigating) {
    return true;
  }
  if (input.key === "ArrowUp") {
    return input.selection.start === 0;
  }
  return input.selection.end === input.valueLength;
}
