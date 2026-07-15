import { describe, expect, it, vi } from "vitest";
import {
  createSwayCommandRunner,
  findFocusedSwayContainerId,
  SwayWindowAttentionController,
  type SwayCommandRunner,
} from "./sway-window-attention";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

describe("sway-window-attention", () => {
  it("finds a focused Paseo view in tiled or floating nodes", () => {
    const tree = {
      id: 1,
      nodes: [
        { id: 2, pid: 50, focused: true, nodes: [] },
        {
          id: 3,
          nodes: [],
          floating_nodes: [{ id: 41, pid: 99, focused: true, nodes: [] }],
        },
      ],
    };

    expect(findFocusedSwayContainerId(tree, 99)).toBe(41);
    expect(findFocusedSwayContainerId(tree, 100)).toBeNull();
    expect(findFocusedSwayContainerId(tree, -1)).toBeNull();
  });

  it("uses fixed swaymsg arguments and validates the environment", async () => {
    const execFile = vi.fn(async (_file: string, args: readonly string[]) => {
      return args[0] === "-t" ? JSON.stringify({ id: 1, nodes: [] }) : '[{"success":true}]';
    });
    const runner = createSwayCommandRunner({
      platform: "linux",
      env: { SWAYSOCK: "/run/user/1000/sway.sock" },
      execFile,
    });

    expect(runner).not.toBeNull();
    await runner?.getTree();
    await runner?.setUrgent(42, true);
    await runner?.setUrgent(42, false);

    expect(execFile).toHaveBeenNthCalledWith(
      1,
      "swaymsg",
      ["-t", "get_tree"],
      expect.objectContaining({ timeout: 2_000, windowsHide: true }),
    );
    expect(execFile).toHaveBeenNthCalledWith(
      2,
      "swaymsg",
      ["[con_id=42]", "urgent", "enable"],
      expect.any(Object),
    );
    expect(execFile).toHaveBeenNthCalledWith(
      3,
      "swaymsg",
      ["[con_id=42]", "urgent", "disable"],
      expect.any(Object),
    );
    expect(createSwayCommandRunner({ platform: "darwin", env: {} })).toBeNull();
    expect(createSwayCommandRunner({ platform: "linux", env: {} })).toBeNull();
  });

  it("applies the latest desired state after mapping the focused container", async () => {
    const setUrgent = vi.fn(async () => {});
    const runner: SwayCommandRunner = {
      getTree: async () => ({ id: 7, pid: 123, focused: true }),
      setUrgent,
    };
    const controller = new SwayWindowAttentionController({ runner, expectedPid: 123 });

    controller.setAttention(1, true);
    controller.setAttention(1, false);
    await controller.captureFocusedContainer(1);
    await controller.flush();

    expect(setUrgent).toHaveBeenCalledTimes(1);
    expect(setUrgent).toHaveBeenCalledWith(7, false);
  });

  it("discards stale tree lookups and keeps the newest container mapping", async () => {
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    const setUrgent = vi.fn(async () => {});
    const getTree = vi
      .fn<() => Promise<unknown>>()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const controller = new SwayWindowAttentionController({
      runner: { getTree, setUrgent },
      expectedPid: 123,
    });

    const firstCapture = controller.captureFocusedContainer(1);
    const secondCapture = controller.captureFocusedContainer(2);
    second.resolve({ id: 22, pid: 123, focused: true });
    await secondCapture;
    controller.setAttention(2, true);
    first.resolve({ id: 11, pid: 123, focused: true });
    await firstCapture;
    controller.setAttention(1, true);
    await controller.flush();

    expect(setUrgent).toHaveBeenCalledTimes(1);
    expect(setUrgent).toHaveBeenCalledWith(22, true);
  });

  it("logs command failures once and keeps processing newer state", async () => {
    const warn = vi.fn();
    const setUrgent = vi
      .fn<(containerId: number, active: boolean) => Promise<void>>()
      .mockRejectedValueOnce(new Error("sway unavailable"))
      .mockResolvedValue(undefined);
    const controller = new SwayWindowAttentionController({
      runner: {
        getTree: async () => ({ id: 9, pid: 123, focused: true }),
        setUrgent,
      },
      expectedPid: 123,
      warn,
    });

    await controller.captureFocusedContainer(1);
    controller.setAttention(1, true);
    await controller.flush();
    controller.setAttention(1, false);
    await controller.flush();

    expect(setUrgent).toHaveBeenNthCalledWith(1, 9, true);
    expect(setUrgent).toHaveBeenNthCalledWith(2, 9, false);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
