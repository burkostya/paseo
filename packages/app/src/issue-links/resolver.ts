import {
  findIssueLinkAtOffset,
  findIssueLinks,
  type IssueLinkMatch,
  type IssueTrackerConfig,
} from "@getpaseo/protocol/issue-trackers";

type TrackersByServer = ReadonlyMap<string, readonly IssueTrackerConfig[]>;

export type IssueLinkResolution =
  | { kind: "none" }
  | { kind: "ambiguous" }
  | { kind: "match"; serverId: string; match: IssueLinkMatch };

export function hasIssueModifierForOs(
  os: "mac" | "non-mac",
  modifiers: { ctrlKey: boolean; metaKey: boolean },
): boolean {
  return os === "mac" ? modifiers.metaKey : modifiers.ctrlKey;
}

function findMatch(
  text: string,
  offset: number | null,
  trackers: readonly IssueTrackerConfig[],
): IssueLinkMatch | null {
  if (offset !== null) return findIssueLinkAtOffset(text, offset, trackers);
  const matches = findIssueLinks(text, trackers);
  return matches.length === 1 ? matches[0] : null;
}

export function resolveIssueLinkForHosts(input: {
  text: string;
  offset: number | null;
  preferredServerId: string | null;
  trackersByServer: TrackersByServer;
}): IssueLinkResolution {
  if (input.preferredServerId) {
    const trackers = input.trackersByServer.get(input.preferredServerId) ?? [];
    const match = findMatch(input.text, input.offset, trackers);
    return match ? { kind: "match", serverId: input.preferredServerId, match } : { kind: "none" };
  }

  const matches: Array<{ serverId: string; match: IssueLinkMatch }> = [];
  for (const [serverId, trackers] of input.trackersByServer) {
    const hostMatches =
      input.offset === null
        ? findIssueLinks(input.text, trackers)
        : [findIssueLinkAtOffset(input.text, input.offset, trackers)].filter(
            (match): match is IssueLinkMatch => match !== null,
          );
    for (const match of hostMatches) matches.push({ serverId, match });
  }
  if (matches.length === 0) return { kind: "none" };

  // Without a caret API, the element text itself must contain exactly one ID.
  // The same source ID may be recognized by multiple hosts and is disambiguated
  // by URL below, but two separate source spans must not pick one arbitrarily.
  if (input.offset === null) {
    const sourceMatches = new Set(
      matches.map(({ match }) => `${match.index}:${match.length}:${match.issueId}`),
    );
    if (sourceMatches.size !== 1) return { kind: "none" };
  }

  const uniqueUrls = new Set(matches.map(({ match }) => match.url));
  if (uniqueUrls.size > 1) return { kind: "ambiguous" };
  const first = matches[0];
  return first ? { kind: "match", ...first } : { kind: "none" };
}
