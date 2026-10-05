import { describe, expect, test } from "vitest";

import type {
  AgentCapabilityFlags,
  AgentPromptInput,
  AgentSession,
  AgentStreamEvent,
  AgentRuntimeInfo,
  AgentPermissionRequest,
  SteerActiveTurnOptions,
  SteerResult,
  ImportedTimelineEntry,
} from "./agent-sdk-types.js";
import { wrapSessionProvider } from "./provider-registry.js";

type OptionalAgentSessionMethodName = {
  [K in keyof AgentSession]-?: undefined extends AgentSession[K]
    ? NonNullable<AgentSession[K]> extends (...args: never[]) => unknown
      ? K
      : never
    : never;
}[keyof AgentSession];

const OPTIONAL_AGENT_SESSION_METHOD_NAMES = [
  "steerActiveTurn",
  "listCommands",
  "setModel",
  "setThinkingOption",
  "setFeature",
  "revertConversation",
  "revertFiles",
  "revertBoth",
  "tryHandleOutOfBand",
] as const satisfies readonly OptionalAgentSessionMethodName[];

type MissingOptionalAgentSessionMethod = Exclude<
  OptionalAgentSessionMethodName,
  (typeof OPTIONAL_AGENT_SESSION_METHOD_NAMES)[number]
>;

const _allOptionalAgentSessionMethodsAreCovered: MissingOptionalAgentSessionMethod extends never
  ? true
  : never = true;

const CAPABILITIES: AgentCapabilityFlags = {
  supportsStreaming: true,
  supportsSessionPersistence: true,
  supportsDynamicModes: true,
  supportsMcpServers: true,
  supportsReasoningStream: true,
  supportsToolInvocations: true,
  supportsRewindConversation: true,
  supportsRewindFiles: true,
  supportsRewindBoth: true,
};

const RUNTIME_INFO: AgentRuntimeInfo = {
  provider: "claude",
  sessionId: "session-1",
};

class FakeSession implements AgentSession {
  readonly provider = "claude";
  id = "session-1";
  capabilities = CAPABILITIES;
  initialTimeline: ImportedTimelineEntry[] = [
    { item: { type: "assistant_message", id: "initial", text: "Provider setup" } },
  ];
  readonly steers: Array<{ prompt: AgentPromptInput; options: SteerActiveTurnOptions }> = [];
  readonly features = [];
  readonly recordedCalls: string[] = [];
  readonly pendingPermissions: AgentPermissionRequest[] = [];
  readonly history: AgentStreamEvent[] = [];
  readonly listeners = new Set<(event: AgentStreamEvent) => void>();

  async run() {
    this.recordedCalls.push("run");
    return { timeline: [] };
  }

  async startTurn() {
    this.recordedCalls.push("startTurn");
    return { turnId: "turn-1" };
  }

  async steerActiveTurn(
    prompt: AgentPromptInput,
    options: SteerActiveTurnOptions,
  ): Promise<SteerResult> {
    this.recordedCalls.push("steerActiveTurn");
    this.steers.push({ prompt, options });
    return { status: "accepted" };
  }

  subscribe(callback: (event: AgentStreamEvent) => void) {
    this.recordedCalls.push("subscribe");
    this.listeners.add(callback);
    return () => {
      this.listeners.delete(callback);
    };
  }

  async *streamHistory() {
    this.recordedCalls.push("streamHistory");
    yield* this.history;
  }

  async getRuntimeInfo() {
    this.recordedCalls.push("getRuntimeInfo");
    return RUNTIME_INFO;
  }

  async getAvailableModes() {
    this.recordedCalls.push("getAvailableModes");
    return [];
  }

  async getCurrentMode() {
    this.recordedCalls.push("getCurrentMode");
    return null;
  }

  async setMode(_modeId: string) {
    this.recordedCalls.push("setMode");
  }

  getPendingPermissions() {
    this.recordedCalls.push("getPendingPermissions");
    return this.pendingPermissions;
  }

  async respondToPermission() {
    this.recordedCalls.push("respondToPermission");
  }

  describePersistence() {
    this.recordedCalls.push("describePersistence");
    return null;
  }

  async interrupt() {
    this.recordedCalls.push("interrupt");
  }

  async close() {
    this.recordedCalls.push("close");
  }

  async listCommands() {
    this.recordedCalls.push("listCommands");
    return [];
  }

  async setModel() {
    this.recordedCalls.push("setModel");
  }

  async setThinkingOption() {
    this.recordedCalls.push("setThinkingOption");
  }

  async setFeature() {
    this.recordedCalls.push("setFeature");
  }

  async revertConversation() {
    this.recordedCalls.push("revertConversation");
  }

  async revertFiles() {
    this.recordedCalls.push("revertFiles");
  }

  async revertBoth() {
    this.recordedCalls.push("revertBoth");
  }

  tryHandleOutOfBand(_prompt: AgentPromptInput) {
    this.recordedCalls.push("tryHandleOutOfBand");
    return {
      run: async () => {
        this.recordedCalls.push("tryHandleOutOfBand.run");
      },
    };
  }
}

describe("wrapSessionProvider", () => {
  test("keeps plan permission identity consistent across live events, history and pending requests", async () => {
    const session = new FakeSession();
    const request: AgentPermissionRequest = {
      id: "plan-1",
      provider: session.provider,
      name: "plan_approval",
      kind: "plan",
      input: { plan: "Implement the proposed changes" },
      metadata: { planText: "Implement the proposed changes" },
    };
    const requested: AgentStreamEvent = {
      type: "permission_requested",
      provider: session.provider,
      request,
      turnId: "turn-1",
    };
    const approved: AgentStreamEvent = {
      type: "timeline",
      provider: session.provider,
      turnId: "turn-1",
      item: {
        type: "tool_call",
        callId: request.id,
        name: "plan_approval",
        status: "completed",
        error: null,
        detail: { type: "plan", text: "Implement the proposed changes" },
        metadata: { approved: true, planResolution: "approved" },
      },
    };
    session.pendingPermissions.push(request);
    session.history.push(requested, approved);
    const originalRequest = structuredClone(request);
    const originalEvents = structuredClone(session.history);
    const wrapped = wrapSessionProvider("custom-claude", session);
    const live: AgentStreamEvent[] = [];
    const unsubscribe = wrapped.subscribe((event) => live.push(event));
    for (const event of session.history) {
      for (const listener of session.listeners) listener(event);
    }
    unsubscribe();

    const history: AgentStreamEvent[] = [];
    for await (const event of wrapped.streamHistory()) history.push(event);
    const mappedRequest = { ...request, provider: "custom-claude" };
    const expectedEvents = [
      { ...requested, provider: "custom-claude", request: mappedRequest },
      { ...approved, provider: "custom-claude" },
    ];
    expect(live).toEqual(expectedEvents);
    expect(history).toEqual(expectedEvents);
    expect(wrapped.getPendingPermissions()).toEqual([mappedRequest]);
    expect(request).toEqual(originalRequest);
    expect(session.history).toEqual(originalEvents);
    expect(session.pendingPermissions).toEqual([originalRequest]);
    expect(session.listeners.size).toBe(0);
  });

  test("forwards every optional AgentSession method", async () => {
    const session = new FakeSession();
    const wrapped = wrapSessionProvider("custom-claude", session);

    await wrapped.steerActiveTurn?.("follow-up", { expectedTurnId: "turn-1" });
    await wrapped.listCommands?.();
    await wrapped.setModel?.("sonnet");
    await wrapped.setThinkingOption?.("high");
    await wrapped.setFeature?.("feature-1", true);
    await wrapped.revertConversation?.({ messageId: "message-1" });
    await wrapped.revertFiles?.({ messageId: "message-1" });
    await wrapped.revertBoth?.({ messageId: "message-1" });
    const handler = wrapped.tryHandleOutOfBand?.("/compact");
    await handler?.run({ emit: () => {} });

    expect(session.steers).toEqual([
      { prompt: "follow-up", options: { expectedTurnId: "turn-1" } },
    ]);
    expect(session.recordedCalls).toEqual([
      "steerActiveTurn",
      "listCommands",
      "setModel",
      "setThinkingOption",
      "setFeature",
      "revertConversation",
      "revertFiles",
      "revertBoth",
      "tryHandleOutOfBand",
      "tryHandleOutOfBand.run",
    ]);
  });
  test("keeps provider-owned session values live", () => {
    const session = new FakeSession();
    const wrapped = wrapSessionProvider("custom-claude", session);
    session.id = "session-2";
    session.capabilities = { ...CAPABILITIES, supportsMcpServers: false };
    expect(wrapped.id).toBe("session-2");
    expect(wrapped.capabilities).toEqual(session.capabilities);
    expect(wrapped.initialTimeline).toEqual(session.initialTimeline);
  });

  test("propagates steering failure without interrupting or replacing the turn", async () => {
    const error = new Error("Provider steer transport failed");
    class RejectingSession extends FakeSession {
      override async steerActiveTurn(): Promise<SteerResult> {
        throw error;
      }
    }
    const session = new RejectingSession();
    const wrapped = wrapSessionProvider("custom-claude", session);
    await expect(wrapped.steerActiveTurn!("follow-up", { expectedTurnId: "turn-1" })).rejects.toBe(
      error,
    );
    expect(session.recordedCalls).toEqual([]);
  });

  test("leaves steering unavailable when the provider has no implementation", () => {
    const session: AgentSession = new FakeSession();
    session.steerActiveTurn = undefined;
    expect(wrapSessionProvider("custom-claude", session).steerActiveTurn).toBeUndefined();
  });
});
