import { describe, expect, test } from "vitest";

import type { AgentStreamEvent } from "../../agent-sdk-types.js";
import {
  streamPiHistory,
  type PiCapturedUserMessageEntry,
  type PiHistoryMapperHooks,
} from "./history-mapper.js";
import type { PiAgentMessage } from "./rpc-types.js";

async function collectHistory(
  messages: PiAgentMessage[],
  userEntries: PiCapturedUserMessageEntry[] = [],
  hooks: PiHistoryMapperHooks = {},
): Promise<AgentStreamEvent[]> {
  const events: AgentStreamEvent[] = [];
  for await (const event of streamPiHistory("pi", messages, userEntries, hooks)) {
    events.push(event);
  }
  return events;
}

describe("Pi history mapper", () => {
  test("renders visible custom messages as completed tools and hides private context", async () => {
    const events = await collectHistory([
      {
        role: "custom",
        customType: "project-context",
        content: "Project instructions",
        display: true,
      },
      {
        role: "custom",
        customType: "private-context",
        content: "Hidden instructions",
        display: false,
      },
      { role: "custom", customType: "project-context", content: "Project instructions" },
    ]);
    expect(events.map((event) => event.item)).toEqual(
      [1, 2].map((index) => ({
        type: "tool_call",
        callId: `pi-custom-${index}`,
        name: "project-context",
        status: "completed",
        detail: { type: "plain_text", text: "Project instructions" },
        metadata: { synthetic: true, customType: "project-context" },
        error: null,
      })),
    );
  });

  test("interleaves command checkpoints without shifting native user identities", async () => {
    const checkpoint = (id: string, messageIndex: number) => ({
      id,
      parentId: null,
      text: `/${id}`,
      timestamp: "2026-10-07T20:00:00.000Z",
      messageIndex,
    });
    const events = await collectHistory(
      [
        { role: "user", content: "first" },
        {
          role: "assistant",
          content: [{ type: "text", text: "first answer" }],
          responseId: "answer-one",
        },
        { role: "user", content: "second" },
        {
          role: "assistant",
          content: [{ type: "text", text: "second answer" }],
          responseId: "answer-two",
        },
      ],
      [
        { id: "user-one", text: "first" },
        { id: "user-two", text: "second" },
      ],
      {
        commandCheckpoints: [
          checkpoint("before", 0),
          checkpoint("middle-one", 2),
          checkpoint("middle-two", 2),
          checkpoint("after", 4),
        ],
      },
    );
    expect(events.flatMap((event) => (event.type === "timeline" ? [event.item] : []))).toEqual([
      { type: "user_message", text: "/before", messageId: "before" },
      { type: "user_message", text: "first", messageId: "user-one" },
      { type: "assistant_message", text: "first answer", messageId: "answer-one" },
      { type: "user_message", text: "/middle-one", messageId: "middle-one" },
      { type: "user_message", text: "/middle-two", messageId: "middle-two" },
      { type: "user_message", text: "second", messageId: "user-two" },
      { type: "assistant_message", text: "second answer", messageId: "answer-two" },
      { type: "user_message", text: "/after", messageId: "after" },
    ]);
  });

  test("keeps command boundaries around hidden and visible extension context", async () => {
    const events = await collectHistory(
      [
        { role: "custom", customType: "private-context", content: "secret", display: false },
        { role: "custom", customType: "project-context", content: "instructions", display: true },
        { role: "user", content: "continue" },
      ],
      [{ id: "native-user", text: "continue" }],
      {
        commandCheckpoints: [
          {
            id: "command-before-context",
            parentId: null,
            text: "/compact",
            timestamp: "2026-10-08T00:00:00.000Z",
            messageIndex: 0,
          },
          {
            id: "command-after-context",
            parentId: "command-before-context",
            text: "/autocompact",
            timestamp: "2026-10-08T00:01:00.000Z",
            messageIndex: 2,
          },
        ],
      },
    );

    expect(events.map((event) => event.item)).toEqual([
      { type: "user_message", text: "/compact", messageId: "command-before-context" },
      {
        type: "tool_call",
        callId: "pi-custom-1",
        name: "project-context",
        status: "completed",
        detail: { type: "plain_text", text: "instructions" },
        metadata: { synthetic: true, customType: "project-context" },
        error: null,
      },
      { type: "user_message", text: "/autocompact", messageId: "command-after-context" },
      { type: "user_message", text: "continue", messageId: "native-user" },
    ]);
  });

  test("replays user, assistant, reasoning, and completed tool calls", async () => {
    await expect(
      collectHistory([
        {
          role: "user",
          content: [
            { type: "text", text: "read this" },
            { type: "image", data: "base64", mimeType: "image/png" },
            { type: "text", text: "then answer" },
          ],
        },
        {
          role: "assistant",
          responseId: "response-1",
          content: [
            { type: "thinking", thinking: "checking file" },
            { type: "toolCall", id: "tool-1", name: "read", arguments: { path: "note.txt" } },
            { type: "text", text: "done" },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "tool-1",
          toolName: "read",
          content: [{ type: "text", text: "file contents" }],
        },
      ]),
    ).resolves.toEqual([
      {
        type: "timeline",
        provider: "pi",
        item: {
          type: "user_message",
          text: "read this\n\nthen answer",
        },
      },
      {
        type: "timeline",
        provider: "pi",
        item: { type: "reasoning", text: "checking file" },
      },
      {
        type: "timeline",
        provider: "pi",
        item: {
          type: "tool_call",
          callId: "tool-1",
          name: "read",
          status: "running",
          detail: {
            type: "read",
            filePath: "note.txt",
            content: undefined,
            offset: undefined,
            limit: undefined,
          },
          error: null,
        },
      },
      {
        type: "timeline",
        provider: "pi",
        item: { type: "assistant_message", text: "done", messageId: "response-1" },
      },
      {
        type: "timeline",
        provider: "pi",
        item: {
          type: "tool_call",
          callId: "tool-1",
          name: "read",
          status: "completed",
          detail: {
            type: "read",
            filePath: "note.txt",
            content: "file contents",
            offset: undefined,
            limit: undefined,
          },
          error: null,
        },
      },
    ]);
  });

  test("replays bash execution records as completed shell calls", async () => {
    await expect(
      collectHistory([
        {
          role: "bashExecution",
          command: "echo hi",
          output: "hi\n",
          exitCode: 0,
          timestamp: 123,
        },
      ]),
    ).resolves.toEqual([
      {
        type: "timeline",
        provider: "pi",
        item: {
          type: "tool_call",
          callId: "pi-bash-123",
          name: "bash",
          status: "completed",
          detail: { type: "shell", command: "echo hi", output: "hi\n", exitCode: 0 },
          error: null,
        },
      },
    ]);
  });

  test("replays custom messages as completed tools, matching the live path", async () => {
    await expect(
      collectHistory([{ role: "custom", content: "Extension command output" }]),
    ).resolves.toEqual([
      {
        type: "timeline",
        provider: "pi",
        item: {
          type: "tool_call",
          callId: "pi-custom-1",
          name: "custom-message",
          status: "completed",
          detail: { type: "plain_text", text: "Extension command output" },
          metadata: { synthetic: true, customType: "custom-message" },
          error: null,
        },
      },
    ]);
  });

  test("uses Pi tree entry ids for replayed user messages", async () => {
    await expect(
      collectHistory(
        [
          { role: "user", content: "first prompt" },
          { role: "assistant", content: [{ type: "text", text: "first answer" }] },
          { role: "user", content: "second prompt" },
        ],
        [
          { id: "entry-user-1", text: "first prompt" },
          { id: "entry-user-2", text: "second prompt" },
        ],
      ),
    ).resolves.toEqual([
      {
        type: "timeline",
        provider: "pi",
        item: {
          type: "user_message",
          text: "first prompt",
          messageId: "entry-user-1",
        },
      },
      {
        type: "timeline",
        provider: "pi",
        item: {
          type: "assistant_message",
          text: "first answer",
          messageId: "pi-history-assistant-1",
        },
      },
      {
        type: "timeline",
        provider: "pi",
        item: {
          type: "user_message",
          text: "second prompt",
          messageId: "entry-user-2",
        },
      },
    ]);
  });
});
