import { z } from "zod";

export const ISSUE_ID_PLACEHOLDER = "{id}";

export const IssueTrackerConfigSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    urlTemplate: z.string(),
    prefixes: z.array(z.string()),
  })
  .passthrough();

export type IssueTrackerConfig = z.infer<typeof IssueTrackerConfigSchema>;

export type IssueTrackerValidationCode =
  | "duplicate_id"
  | "duplicate_prefix"
  | "empty_id"
  | "empty_name"
  | "empty_prefix"
  | "empty_prefixes"
  | "invalid_url_template"
  | "missing_id_placeholder";

export interface IssueTrackerValidationIssue {
  code: IssueTrackerValidationCode;
  trackerIndex: number;
  prefixIndex?: number;
  duplicateTrackerIndex?: number;
}

export interface IssueLinkMatch {
  trackerId: string;
  trackerName: string;
  issueId: string;
  url: string;
  index: number;
  length: number;
}

function isHttpUrlTemplate(urlTemplate: string): boolean {
  try {
    const sampleUrl = urlTemplate.split(ISSUE_ID_PLACEHOLDER).join("PASEO-123");
    const parsed = new URL(sampleUrl);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export function validateIssueTrackerConfigs(
  trackers: readonly IssueTrackerConfig[],
): IssueTrackerValidationIssue[] {
  const issues: IssueTrackerValidationIssue[] = [];
  const idOwners = new Map<string, number>();
  const prefixOwners = new Map<string, number>();

  trackers.forEach((tracker, trackerIndex) => {
    const id = tracker.id.trim();
    if (!id) {
      issues.push({ code: "empty_id", trackerIndex });
    } else {
      const duplicateTrackerIndex = idOwners.get(id);
      if (duplicateTrackerIndex !== undefined) {
        issues.push({ code: "duplicate_id", trackerIndex, duplicateTrackerIndex });
      } else {
        idOwners.set(id, trackerIndex);
      }
    }

    if (!tracker.name.trim()) {
      issues.push({ code: "empty_name", trackerIndex });
    }

    if (tracker.prefixes.length === 0) {
      issues.push({ code: "empty_prefixes", trackerIndex });
    }
    tracker.prefixes.forEach((rawPrefix, prefixIndex) => {
      const prefix = rawPrefix.trim();
      if (!prefix || prefix !== rawPrefix) {
        issues.push({ code: "empty_prefix", trackerIndex, prefixIndex });
        return;
      }
      const duplicateTrackerIndex = prefixOwners.get(prefix);
      if (duplicateTrackerIndex !== undefined) {
        issues.push({
          code: "duplicate_prefix",
          trackerIndex,
          prefixIndex,
          duplicateTrackerIndex,
        });
        return;
      }
      prefixOwners.set(prefix, trackerIndex);
    });

    const urlTemplate = tracker.urlTemplate.trim();
    if (!urlTemplate.includes(ISSUE_ID_PLACEHOLDER)) {
      issues.push({ code: "missing_id_placeholder", trackerIndex });
    } else if (urlTemplate !== tracker.urlTemplate || !isHttpUrlTemplate(urlTemplate)) {
      issues.push({ code: "invalid_url_template", trackerIndex });
    }
  });

  return issues;
}

export function assertValidIssueTrackerConfigs(trackers: readonly IssueTrackerConfig[]): void {
  const issue = validateIssueTrackerConfigs(trackers)[0];
  if (!issue) return;
  throw new Error(
    `Invalid issue tracker configuration: ${issue.code} at index ${issue.trackerIndex}`,
  );
}

export function buildIssueUrl(urlTemplate: string, issueId: string): string {
  return urlTemplate.split(ISSUE_ID_PLACEHOLDER).join(encodeURIComponent(issueId));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function findIssueLinks(
  text: string,
  trackers: readonly IssueTrackerConfig[],
): IssueLinkMatch[] {
  if (!text || trackers.length === 0) return [];

  const matches: Array<IssueLinkMatch & { trackerIndex: number; prefixLength: number }> = [];
  trackers.forEach((tracker, trackerIndex) => {
    for (const prefix of tracker.prefixes) {
      if (!prefix) continue;
      const pattern = new RegExp(
        `(^|[^\\p{L}\\p{N}])(${escapeRegExp(prefix)}[0-9]+)(?![\\p{L}\\p{N}])`,
        "gu",
      );
      for (const match of text.matchAll(pattern)) {
        const issueId = match[2];
        if (!issueId || match.index === undefined) continue;
        const index = match.index + (match[1]?.length ?? 0);
        matches.push({
          trackerId: tracker.id,
          trackerName: tracker.name,
          issueId,
          url: buildIssueUrl(tracker.urlTemplate, issueId),
          index,
          length: issueId.length,
          trackerIndex,
          prefixLength: prefix.length,
        });
      }
    }
  });

  matches.sort((left, right) => {
    if (left.index !== right.index) return left.index - right.index;
    if (left.prefixLength !== right.prefixLength) return right.prefixLength - left.prefixLength;
    return left.trackerIndex - right.trackerIndex;
  });

  const result: IssueLinkMatch[] = [];
  let consumedUntil = -1;
  for (const { trackerIndex: _trackerIndex, prefixLength: _prefixLength, ...match } of matches) {
    if (match.index < consumedUntil) continue;
    result.push(match);
    consumedUntil = match.index + match.length;
  }
  return result;
}

export function findIssueLinkAtOffset(
  text: string,
  offset: number,
  trackers: readonly IssueTrackerConfig[],
): IssueLinkMatch | null {
  return (
    findIssueLinks(text, trackers).find(
      (match) => offset >= match.index && offset < match.index + match.length,
    ) ?? null
  );
}
