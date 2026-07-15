import { describe, expect, it } from "vitest";
import type { IssueTrackerConfig } from "@getpaseo/protocol/issue-trackers";
import { createIssueAwareMarkdownParser } from "./markdown";

const trackers: IssueTrackerConfig[] = [
  {
    id: "issues",
    name: "Issues",
    urlTemplate: "https://issues.example/browse/{id}",
    prefixes: ["APP-"],
  },
];

interface ParsedToken {
  type: string;
  content: string;
  children?: ParsedToken[] | null;
  attrGet(name: string): string | null;
}

function parse(markdown: string): ParsedToken[] {
  return createIssueAwareMarkdownParser(trackers).parse(markdown, {}) as ParsedToken[];
}

function inlineChildren(tokens: ParsedToken[]): ParsedToken[] {
  return tokens.flatMap((token) => token.children ?? []);
}

describe("issue links in Markdown", () => {
  it("links IDs in paragraphs, headings, and list items", () => {
    const children = inlineChildren(parse("# APP-1\n\n- APP-2\n\nText APP-3"));
    const hrefs = children
      .filter((token) => token.type === "link_open")
      .map((token) => token.attrGet("href"));

    expect(hrefs).toEqual([
      "https://issues.example/browse/APP-1",
      "https://issues.example/browse/APP-2",
      "https://issues.example/browse/APP-3",
    ]);
  });

  it("leaves existing links, inline code, and fenced code untouched", () => {
    const tokens = parse(
      "[APP-1](https://example.com/existing) `APP-2`\n\n```text\nAPP-3\n```\n\nAPP-4",
    );
    const children = inlineChildren(tokens);
    const hrefs = children
      .filter((token) => token.type === "link_open")
      .map((token) => token.attrGet("href"));

    expect(hrefs).toEqual(["https://example.com/existing", "https://issues.example/browse/APP-4"]);
    expect(tokens.find((token) => token.type === "fence")?.content).toBe("APP-3\n");
    expect(children.find((token) => token.type === "code_inline")?.content).toBe("APP-2");
  });
});
