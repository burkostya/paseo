import { describe, expect, it } from "vitest";
import type { StreamItem, UserMessageItem } from "@/types/stream";
import {
  buildComposerHistoryEntries,
  getComposerHistoryNavigationResult,
  initialComposerHistoryNavigationState,
  shouldNavigateComposerHistory,
} from "./history";

function userMessage(id: string, text: string, timestamp: number): UserMessageItem {
  return {
    kind: "user_message",
    id,
    text,
    timestamp: new Date(timestamp),
  };
}

function assistantMessage(id: string, text: string, timestamp: number): StreamItem {
  return {
    kind: "assistant_message",
    id,
    text,
    timestamp: new Date(timestamp),
  };
}

describe("buildComposerHistoryEntries", () => {
  it("extracts user messages from head and tail in chronological order", () => {
    const entries = buildComposerHistoryEntries({
      head: [userMessage("u3", "third", 3)],
      tail: [
        userMessage("u1", "first", 1),
        assistantMessage("a1", "answer", 2),
        userMessage("u2", "second", 2),
      ],
    });

    expect(entries.map((entry) => entry.text)).toEqual(["first", "second", "third"]);
  });

  it("ignores blank messages and adjacent identical prompts", () => {
    const entries = buildComposerHistoryEntries({
      head: [],
      tail: [
        userMessage("blank", "  ", 1),
        userMessage("first", "repeat", 2),
        userMessage("duplicate", "repeat", 3),
        assistantMessage("a1", "answer", 4),
        userMessage("middle", "different", 5),
        userMessage("later", "repeat", 6),
      ],
    });

    expect(entries.map((entry) => entry.id)).toEqual(["first", "middle", "later"]);
  });
});

describe("composer history navigation", () => {
  const entries = [
    { id: "one", text: "first prompt" },
    { id: "two", text: "second prompt" },
  ];

  it("captures and restores the current draft after moving past the newest entry", () => {
    const older = getComposerHistoryNavigationResult({
      state: initialComposerHistoryNavigationState,
      entries,
      draft: "unsent draft",
      direction: "older",
    });

    expect(older?.value).toBe("second prompt");

    const newer = getComposerHistoryNavigationResult({
      state: older?.state ?? initialComposerHistoryNavigationState,
      entries,
      draft: "second prompt",
      direction: "newer",
    });

    expect(newer).toEqual({
      state: initialComposerHistoryNavigationState,
      value: "unsent draft",
    });
  });

  it("does not overwrite the captured draft while navigating older prompts", () => {
    const newest = getComposerHistoryNavigationResult({
      state: initialComposerHistoryNavigationState,
      entries,
      draft: "original draft",
      direction: "older",
    });
    const oldest = getComposerHistoryNavigationResult({
      state: newest?.state ?? initialComposerHistoryNavigationState,
      entries,
      draft: "second prompt edited by navigation",
      direction: "older",
    });

    expect(oldest?.state.draftBeforeNavigation).toBe("original draft");
    expect(oldest?.value).toBe("first prompt");
  });

  it("only starts navigation from collapsed boundary selections", () => {
    expect(
      shouldNavigateComposerHistory({
        key: "ArrowUp",
        selection: { start: 0, end: 0 },
        valueLength: 10,
        isNavigating: false,
      }),
    ).toBe(true);
    expect(
      shouldNavigateComposerHistory({
        key: "ArrowDown",
        selection: { start: 10, end: 10 },
        valueLength: 10,
        isNavigating: false,
      }),
    ).toBe(true);
    expect(
      shouldNavigateComposerHistory({
        key: "ArrowUp",
        selection: { start: 5, end: 5 },
        valueLength: 10,
        isNavigating: false,
      }),
    ).toBe(false);
    expect(
      shouldNavigateComposerHistory({
        key: "ArrowDown",
        selection: { start: 2, end: 5 },
        valueLength: 10,
        isNavigating: true,
      }),
    ).toBe(false);
  });
});
