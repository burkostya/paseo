import { findIssueLinks, type IssueTrackerConfig } from "@getpaseo/protocol/issue-trackers";
import MarkdownIt from "markdown-it";

interface MarkdownToken {
  type: string;
  content: string;
  children?: MarkdownToken[] | null;
  attrSet(name: string, value: string): void;
}

interface MarkdownState {
  Token: new (type: string, tag: string, nesting: -1 | 0 | 1) => MarkdownToken;
  tokens: MarkdownToken[];
}

function splitTextToken(
  state: MarkdownState,
  token: MarkdownToken,
  trackers: readonly IssueTrackerConfig[],
): MarkdownToken[] {
  const matches = findIssueLinks(token.content, trackers);
  if (matches.length === 0) return [token];

  const result: MarkdownToken[] = [];
  let cursor = 0;
  for (const match of matches) {
    if (match.index > cursor) {
      const text = new state.Token("text", "", 0);
      text.content = token.content.slice(cursor, match.index);
      result.push(text);
    }

    const open = new state.Token("link_open", "a", 1);
    open.attrSet("href", match.url);
    open.attrSet("data-issue-link", "true");
    const label = new state.Token("text", "", 0);
    label.content = match.issueId;
    const close = new state.Token("link_close", "a", -1);
    result.push(open, label, close);
    cursor = match.index + match.length;
  }

  if (cursor < token.content.length) {
    const text = new state.Token("text", "", 0);
    text.content = token.content.slice(cursor);
    result.push(text);
  }
  return result;
}

function linkifyInlineChildren(
  state: MarkdownState,
  children: MarkdownToken[],
  trackers: readonly IssueTrackerConfig[],
): MarkdownToken[] {
  const result: MarkdownToken[] = [];
  let linkDepth = 0;
  for (const token of children) {
    if (token.type === "link_open") {
      linkDepth += 1;
      result.push(token);
      continue;
    }
    if (token.type === "link_close") {
      linkDepth = Math.max(0, linkDepth - 1);
      result.push(token);
      continue;
    }
    if (token.type === "text" && linkDepth === 0) {
      result.push(...splitTextToken(state, token, trackers));
      continue;
    }
    result.push(token);
  }
  return result;
}

export function addIssueLinksToMarkdown(
  parser: MarkdownIt,
  trackers: readonly IssueTrackerConfig[],
): MarkdownIt {
  if (trackers.length === 0) return parser;
  parser.core.ruler.after("inline", "paseo_issue_links", (state) => {
    const markdownState = state as unknown as MarkdownState;
    for (const token of markdownState.tokens) {
      if (token.type !== "inline" || !token.children) continue;
      token.children = linkifyInlineChildren(markdownState, token.children, trackers);
    }
  });
  return parser;
}

export function createIssueAwareMarkdownParser(
  trackers: readonly IssueTrackerConfig[],
  configure?: (parser: MarkdownIt) => void,
): MarkdownIt {
  // Keep literal agent/file text intact. The shared parser contract disables
  // typographer substitutions such as `(c)` -> `©` and smart quotes.
  const parser = new MarkdownIt({ html: false, typographer: false, linkify: true });
  configure?.(parser);
  return addIssueLinksToMarkdown(parser, trackers);
}
