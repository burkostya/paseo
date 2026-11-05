import { describe, expect, it, vi } from "vitest";
import {
  WindowAttentionManager,
  type AttentionWindow,
  type SwayWindowAttentionAdapter,
} from "./window-attention-manager";

class FakeWindow implements AttentionWindow {
  destroyed = false;
  focused = false;
  readonly flashFrame = vi.fn<(active: boolean) => void>();

  constructor(readonly id: number) {}

  isDestroyed(): boolean {
    return this.destroyed;
  }

  isFocused(): boolean {
    return this.focused;
  }
}

function createSwayAdapter() {
  return {
    captureFocusedContainer: vi.fn(async () => {}),
    forgetWindow: vi.fn(),
    setAttention: vi.fn(),
  } satisfies SwayWindowAttentionAdapter;
}

function createScheduler() {
  const callbacks: Array<() => void> = [];
  return {
    flush(): void {
      while (callbacks.length > 0) {
        callbacks.shift()?.();
      }
    },
    schedule(callback: () => void): void {
      callbacks.push(callback);
    },
  };
}

describe("window-attention-manager", () => {
  it("keeps urgency on only the last used Paseo window", () => {
    const sway = createSwayAdapter();
    const scheduler = createScheduler();
    const first = new FakeWindow(1);
    const second = new FakeWindow(2);
    first.focused = true;
    const manager = new WindowAttentionManager({
      platform: "linux",
      schedule: scheduler.schedule,
      sway,
    });

    manager.registerWindow(first);
    manager.registerWindow(second);
    manager.setRequested(first, true);
    manager.setRequested(second, true);
    expect(first.flashFrame).not.toHaveBeenCalled();

    first.focused = false;
    manager.handleBlur(first);
    scheduler.flush();
    expect(first.flashFrame).toHaveBeenLastCalledWith(true);
    expect(sway.setAttention).toHaveBeenLastCalledWith(1, true);

    second.focused = true;
    manager.handleFocus(second);
    expect(first.flashFrame).toHaveBeenLastCalledWith(false);
    expect(second.flashFrame).not.toHaveBeenCalledWith(true);

    second.focused = false;
    manager.handleBlur(second);
    scheduler.flush();
    expect(second.flashFrame).toHaveBeenLastCalledWith(true);
    expect(sway.setAttention).toHaveBeenLastCalledWith(2, true);
  });

  it("ORs renderer state and clears only after every window resolves", () => {
    const sway = createSwayAdapter();
    const target = new FakeWindow(1);
    const mirror = new FakeWindow(2);
    const manager = new WindowAttentionManager({ platform: "linux", sway });
    manager.registerWindow(target);
    manager.registerWindow(mirror);

    manager.setRequested(target, true);
    manager.setRequested(mirror, true);
    expect(target.flashFrame).toHaveBeenLastCalledWith(true);

    manager.setRequested(target, false);
    expect(target.flashFrame).toHaveBeenLastCalledWith(true);

    manager.resetRenderer(mirror);
    expect(target.flashFrame).toHaveBeenLastCalledWith(false);
    expect(sway.setAttention).toHaveBeenLastCalledWith(1, false);
  });

  it("clears a closing target and falls back to the remaining requested window", () => {
    const sway = createSwayAdapter();
    const scheduler = createScheduler();
    const first = new FakeWindow(1);
    const second = new FakeWindow(2);
    first.focused = true;
    const manager = new WindowAttentionManager({
      platform: "linux",
      schedule: scheduler.schedule,
      sway,
    });
    manager.registerWindow(first);
    manager.registerWindow(second);
    manager.setRequested(second, true);

    first.focused = false;
    manager.handleBlur(first);
    scheduler.flush();
    manager.unregisterWindow(first);

    expect(first.flashFrame).toHaveBeenLastCalledWith(false);
    expect(sway.forgetWindow).toHaveBeenCalledWith(1);
    expect(second.flashFrame).toHaveBeenLastCalledWith(true);
  });

  it("does not call native attention APIs outside Linux", () => {
    const window = new FakeWindow(1);
    const manager = new WindowAttentionManager({ platform: "darwin" });
    manager.registerWindow(window);
    manager.setRequested(window, true);
    expect(window.flashFrame).not.toHaveBeenCalled();
  });
});
