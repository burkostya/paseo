import { describe, expect, it } from "vitest";
import {
  buildIssueUrl,
  findIssueLinkAtOffset,
  findIssueLinks,
  IssueTrackerConfigSchema,
  validateIssueTrackerConfigs,
  type IssueTrackerConfig,
} from "./issue-trackers.js";
import { MutableDaemonConfigSchema, ServerInfoStatusPayloadSchema } from "./messages.js";

const trackers: IssueTrackerConfig[] = [
  {
    id: "linear",
    name: "Linear",
    urlTemplate: "https://linear.example/issue/{id}?selected={id}",
    prefixes: ["APP-", "PASEO-"],
  },
];

describe("issue tracker configuration", () => {
  it("keeps issue trackers and the capability optional for old hosts", () => {
    expect(
      MutableDaemonConfigSchema.parse({ mcp: { injectIntoAgents: false } }).issueTrackers,
    ).toBeUndefined();
    expect(
      ServerInfoStatusPayloadSchema.parse({ status: "server_info", serverId: "old" }).features
        ?.issueLinks,
    ).toBeUndefined();
    expect(
      ServerInfoStatusPayloadSchema.parse({
        status: "server_info",
        serverId: "new",
        features: { issueLinks: true },
      }).features?.issueLinks,
    ).toBe(true);
  });

  it("accepts additive tracker fields for protocol compatibility", () => {
    expect(
      IssueTrackerConfigSchema.parse({ ...trackers[0], futureField: "preserved" }),
    ).toHaveProperty("futureField", "preserved");
  });

  it("rejects duplicate prefixes and invalid URL templates", () => {
    const issues = validateIssueTrackerConfigs([
      trackers[0]!,
      {
        id: "jira",
        name: "Jira",
        urlTemplate: "javascript:alert({id})",
        prefixes: ["APP-"],
      },
    ]);

    expect(issues.map((issue) => issue.code)).toEqual(["duplicate_prefix", "invalid_url_template"]);
  });
});

describe("issue ID resolver", () => {
  it("matches exact-case prefixes with numeric suffixes and token boundaries", () => {
    const text = "APP-12 app-13 XAPP-14 APP-15x ЖAPP-16 APP-17Ж (PASEO-18)";
    expect(findIssueLinks(text, trackers).map((match) => match.issueId)).toEqual([
      "APP-12",
      "PASEO-18",
    ]);
  });

  it("does not accept an empty or non-numeric suffix", () => {
    expect(findIssueLinks("APP- APP-one APP-123", trackers).map((match) => match.issueId)).toEqual([
      "APP-123",
    ]);
  });

  it("percent-encodes the complete issue ID in every placeholder", () => {
    expect(buildIssueUrl("https://issues.example/{id}?id={id}", "OPS/42")).toBe(
      "https://issues.example/OPS%2F42?id=OPS%2F42",
    );
  });

  it("resolves only offsets inside the issue ID", () => {
    const text = "See APP-12 next";
    expect(findIssueLinkAtOffset(text, 5, trackers)?.issueId).toBe("APP-12");
    expect(findIssueLinkAtOffset(text, 10, trackers)).toBeNull();
  });
});
