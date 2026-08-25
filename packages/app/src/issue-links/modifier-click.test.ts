import { describe, expect, it } from "vitest";
import type { IssueTrackerConfig } from "@getpaseo/protocol/issue-trackers";
import { hasIssueModifierForOs, resolveIssueLinkForHosts } from "./resolver";

function tracker(urlTemplate: string, prefixes = ["APP-"]): IssueTrackerConfig {
  return { id: urlTemplate, name: "Issues", urlTemplate, prefixes };
}

describe("modifier-click issue resolution", () => {
  it("maps Ctrl on Windows/Linux and Cmd on macOS", () => {
    expect(hasIssueModifierForOs("non-mac", { ctrlKey: true, metaKey: false })).toBe(true);
    expect(hasIssueModifierForOs("non-mac", { ctrlKey: false, metaKey: true })).toBe(false);
    expect(hasIssueModifierForOs("mac", { ctrlKey: false, metaKey: true })).toBe(true);
    expect(hasIssueModifierForOs("mac", { ctrlKey: true, metaKey: false })).toBe(false);
  });

  it("uses the nearest or active host without consulting other hosts", () => {
    const result = resolveIssueLinkForHosts({
      text: "APP-42",
      offset: 2,
      preferredServerId: "host-b",
      trackersByServer: new Map([
        ["host-a", [tracker("https://a.example/{id}")]],
        ["host-b", [tracker("https://b.example/{id}")]],
      ]),
    });

    expect(result).toMatchObject({
      kind: "match",
      serverId: "host-b",
      match: { url: "https://b.example/APP-42" },
    });
  });

  it("reports ambiguity when hosts map the same source ID to different URLs", () => {
    expect(
      resolveIssueLinkForHosts({
        text: "APP-42",
        offset: null,
        preferredServerId: null,
        trackersByServer: new Map([
          ["host-a", [tracker("https://a.example/{id}")]],
          ["host-b", [tracker("https://b.example/{id}")]],
        ]),
      }),
    ).toEqual({ kind: "ambiguous" });
  });

  it("allows identical mappings across hosts", () => {
    expect(
      resolveIssueLinkForHosts({
        text: "APP-42",
        offset: null,
        preferredServerId: null,
        trackersByServer: new Map([
          ["host-a", [tracker("https://issues.example/{id}")]],
          ["host-b", [tracker("https://issues.example/{id}")]],
        ]),
      }),
    ).toMatchObject({ kind: "match", match: { issueId: "APP-42" } });
  });

  it("does nothing without caret data when the element contains multiple IDs", () => {
    expect(
      resolveIssueLinkForHosts({
        text: "APP-1 and CORE-2",
        offset: null,
        preferredServerId: null,
        trackersByServer: new Map([
          ["host-a", [tracker("https://issues.example/{id}", ["APP-"])]],
          ["host-b", [tracker("https://issues.example/{id}", ["CORE-"])]],
        ]),
      }),
    ).toEqual({ kind: "none" });
  });
});
