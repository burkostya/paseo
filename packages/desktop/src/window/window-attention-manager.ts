export interface AttentionWindow {
  readonly id: number;
  flashFrame(active: boolean): void;
  isDestroyed(): boolean;
  isFocused(): boolean;
}

export interface SwayWindowAttentionAdapter {
  captureFocusedContainer(windowId: number): Promise<void>;
  forgetWindow(windowId: number): void;
  setAttention(windowId: number, active: boolean): void;
}

interface WindowAttentionManagerInput {
  platform?: NodeJS.Platform;
  schedule?: (callback: () => void) => void;
  sway?: SwayWindowAttentionAdapter | null;
  warn?: (message: string, error: unknown) => void;
}

interface WindowAttentionState {
  applied: boolean;
  focusOrder: number;
  requested: boolean;
  window: AttentionWindow;
}

export class WindowAttentionManager {
  private readonly platform: NodeJS.Platform;
  private readonly schedule: (callback: () => void) => void;
  private readonly sway: SwayWindowAttentionAdapter | null;
  private readonly warn: (message: string, error: unknown) => void;
  private readonly windows = new Map<number, WindowAttentionState>();
  private focusSequence = 0;
  private lastFocusedWindowId: number | null = null;
  private reconcileScheduled = false;

  constructor(input: WindowAttentionManagerInput = {}) {
    this.platform = input.platform ?? process.platform;
    this.schedule = input.schedule ?? queueMicrotask;
    this.sway = input.sway ?? null;
    this.warn = input.warn ?? console.warn;
  }

  registerWindow(window: AttentionWindow): void {
    if (this.windows.has(window.id)) {
      return;
    }

    const focused = window.isFocused();
    const focusOrder = focused ? ++this.focusSequence : 0;
    this.windows.set(window.id, {
      applied: false,
      focusOrder,
      requested: false,
      window,
    });

    if (focused || this.lastFocusedWindowId === null) {
      this.lastFocusedWindowId = window.id;
    }
    if (focused) {
      void this.sway?.captureFocusedContainer(window.id);
    }
    this.reconcile();
  }

  unregisterWindow(window: AttentionWindow): void {
    const state = this.windows.get(window.id);
    if (!state) {
      return;
    }

    if (state.applied) {
      state.applied = false;
      this.flashFrame(state.window, false);
    }
    this.sway?.forgetWindow(window.id);
    this.windows.delete(window.id);

    if (this.lastFocusedWindowId === window.id) {
      this.lastFocusedWindowId = this.findMostRecentlyFocusedWindowId();
    }
    this.reconcile();
  }

  setRequested(window: AttentionWindow, requested: boolean): void {
    const state = this.windows.get(window.id);
    if (!state || state.requested === requested) {
      return;
    }
    state.requested = requested;
    this.reconcile();
  }

  resetRenderer(window: AttentionWindow): void {
    this.setRequested(window, false);
  }

  handleFocus(window: AttentionWindow): void {
    const state = this.windows.get(window.id);
    if (!state) {
      return;
    }
    state.focusOrder = ++this.focusSequence;
    this.lastFocusedWindowId = window.id;
    void this.sway?.captureFocusedContainer(window.id);
    this.reconcile();
  }

  handleBlur(window: AttentionWindow): void {
    if (!this.windows.has(window.id) || this.reconcileScheduled) {
      return;
    }
    this.reconcileScheduled = true;
    this.schedule(() => {
      this.reconcileScheduled = false;
      this.reconcile();
    });
  }

  private reconcile(): void {
    const targetId = this.resolveTargetWindowId();
    const hasRequestedAttention = Array.from(this.windows.values()).some(
      (state) => state.requested && !state.window.isDestroyed(),
    );
    const target = targetId === null ? null : this.windows.get(targetId);
    const shouldApplyToTarget =
      hasRequestedAttention &&
      target !== null &&
      target !== undefined &&
      !target.window.isDestroyed() &&
      !target.window.isFocused();

    for (const [windowId, state] of this.windows) {
      this.apply(state, windowId === targetId && shouldApplyToTarget);
    }
  }

  private resolveTargetWindowId(): number | null {
    if (this.lastFocusedWindowId !== null) {
      const lastFocused = this.windows.get(this.lastFocusedWindowId);
      if (lastFocused && !lastFocused.window.isDestroyed()) {
        return this.lastFocusedWindowId;
      }
    }
    return this.findMostRecentlyFocusedWindowId();
  }

  private findMostRecentlyFocusedWindowId(): number | null {
    let match: WindowAttentionState | null = null;
    for (const state of this.windows.values()) {
      if (state.window.isDestroyed()) {
        continue;
      }
      if (!match || state.focusOrder > match.focusOrder) {
        match = state;
      }
    }
    return match?.window.id ?? null;
  }

  private apply(state: WindowAttentionState, active: boolean): void {
    if (state.applied === active) {
      return;
    }
    state.applied = active;
    this.flashFrame(state.window, active);
    this.sway?.setAttention(state.window.id, active);
  }

  private flashFrame(window: AttentionWindow, active: boolean): void {
    if (this.platform !== "linux" || window.isDestroyed()) {
      return;
    }
    try {
      window.flashFrame(active);
    } catch (error) {
      this.warn("[window-attention] Failed to update native window attention", error);
    }
  }
}
