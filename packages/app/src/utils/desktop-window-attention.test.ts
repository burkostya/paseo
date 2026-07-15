import { describe, expect, it, vi } from "vitest";
import type { DesktopHostBridge } from "@/desktop/host";
import { createDesktopWindowAttentionReporter } from "./desktop-window-attention";

function createHost(setAttention: (active: boolean) => Promise<void>): DesktopHostBridge {
  return {
    platform: "linux",
    window: {
      getCurrentWindow: () => ({ setAttention }),
    },
  };
}

describe("desktop-window-attention", () => {
  it("reports state transitions once", () => {
    const setAttention = vi.fn(async () => {});
    const reporter = createDesktopWindowAttentionReporter({
      getHost: () => createHost(setAttention),
    });

    reporter.report(false);
    reporter.report(false);
    reporter.report(true);
    reporter.report(true);
    reporter.report(false);

    expect(setAttention).toHaveBeenCalledTimes(3);
    expect(setAttention).toHaveBeenNthCalledWith(1, false);
    expect(setAttention).toHaveBeenNthCalledWith(2, true);
    expect(setAttention).toHaveBeenNthCalledWith(3, false);
  });

  it("is a no-op without the Linux Electron bridge", () => {
    const setAttention = vi.fn(async () => {});
    const missingHost = createDesktopWindowAttentionReporter({ getHost: () => null });
    const macHost = createDesktopWindowAttentionReporter({
      getHost: () => ({ ...createHost(setAttention), platform: "darwin" }),
    });

    expect(() => missingHost.report(true)).not.toThrow();
    expect(() => macHost.report(true)).not.toThrow();
    expect(setAttention).not.toHaveBeenCalled();
  });

  it("logs rejected bridge updates without throwing", async () => {
    const error = new Error("ipc failed");
    const warn = vi.fn();
    const reporter = createDesktopWindowAttentionReporter({
      getHost: () => createHost(() => Promise.reject(error)),
      warn,
    });

    reporter.report(true);
    await vi.waitFor(() => {
      expect(warn).toHaveBeenCalledWith(
        "[desktop-window-attention] Failed to update window attention",
        error,
      );
    });
  });
});
