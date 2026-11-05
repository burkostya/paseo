import { describe, expect, it } from "vitest";
import {
  createContinueAfterErrorSubmitter,
  resolveContinueAfterErrorActionState,
} from "./continue-after-error";

const idleError = {
  hasError: true,
  isAgentTurnActive: false,
  hasPendingPermission: false,
  isArchived: false,
  isConnected: true,
  isSending: false,
};

describe("resolveContinueAfterErrorActionState", () => {
  it("shows the action for a final error", () => {
    expect(resolveContinueAfterErrorActionState(idleError)).toBe("ready");
  });

  it("hides the action while the agent is retrying or has an active turn", () => {
    expect(resolveContinueAfterErrorActionState({ ...idleError, hasError: false })).toBe("hidden");
    expect(resolveContinueAfterErrorActionState({ ...idleError, isAgentTurnActive: true })).toBe(
      "hidden",
    );
  });

  it("hides the action while a permission is pending or the agent is archived", () => {
    expect(resolveContinueAfterErrorActionState({ ...idleError, hasPendingPermission: true })).toBe(
      "hidden",
    );
    expect(resolveContinueAfterErrorActionState({ ...idleError, isArchived: true })).toBe("hidden");
  });

  it("disables the action while the host is disconnected", () => {
    expect(resolveContinueAfterErrorActionState({ ...idleError, isConnected: false })).toBe(
      "disabled",
    );
  });

  it("shows a busy action while its message is being sent", () => {
    expect(resolveContinueAfterErrorActionState({ ...idleError, isSending: true })).toBe("sending");
  });

  it("makes the action available again after a failed send", () => {
    expect(resolveContinueAfterErrorActionState({ ...idleError, isSending: true })).toBe("sending");
    expect(resolveContinueAfterErrorActionState(idleError)).toBe("ready");
  });
});

describe("createContinueAfterErrorSubmitter", () => {
  it("accepts only one simultaneous submission", async () => {
    const submitOnce = createContinueAfterErrorSubmitter();
    let releaseFirst!: () => void;
    const firstSubmission = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let sendCount = 0;

    const first = submitOnce(async () => {
      sendCount += 1;
      await firstSubmission;
    });
    const second = await submitOnce(async () => {
      sendCount += 1;
    });

    expect(second).toBe(false);
    releaseFirst();
    await expect(first).resolves.toBe(true);
    expect(sendCount).toBe(1);
  });

  it("releases the submission gate when sending fails", async () => {
    const submitOnce = createContinueAfterErrorSubmitter();
    const error = new Error("Host disconnected");

    await expect(submitOnce(async () => Promise.reject(error))).rejects.toBe(error);
    await expect(submitOnce(async () => {})).resolves.toBe(true);
  });
});
