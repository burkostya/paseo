import { execFile as nodeExecFile } from "node:child_process";

const SWAY_COMMAND_TIMEOUT_MS = 2_000;
const SWAY_TREE_MAX_BUFFER_BYTES = 4 * 1024 * 1024;

type SwayExecFile = (
  file: string,
  args: readonly string[],
  options: {
    encoding: "utf8";
    env: NodeJS.ProcessEnv;
    maxBuffer: number;
    timeout: number;
    windowsHide: boolean;
  },
) => Promise<string>;

interface CreateSwayCommandRunnerInput {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  execFile?: SwayExecFile;
}

export interface SwayCommandRunner {
  getTree(): Promise<unknown>;
  setUrgent(containerId: number, active: boolean): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function findFocusedContainerInNode(node: unknown, expectedPid: number): number | null {
  if (!isRecord(node)) {
    return null;
  }

  if (
    node.focused === true &&
    node.pid === expectedPid &&
    typeof node.id === "number" &&
    Number.isSafeInteger(node.id) &&
    node.id > 0
  ) {
    return node.id;
  }

  for (const childKey of ["nodes", "floating_nodes"] as const) {
    const children = node[childKey];
    if (!Array.isArray(children)) {
      continue;
    }
    for (const child of children) {
      const match = findFocusedContainerInNode(child, expectedPid);
      if (match !== null) {
        return match;
      }
    }
  }

  return null;
}

export function findFocusedSwayContainerId(tree: unknown, expectedPid: number): number | null {
  if (!Number.isSafeInteger(expectedPid) || expectedPid <= 0) {
    return null;
  }
  return findFocusedContainerInNode(tree, expectedPid);
}

const defaultExecFile: SwayExecFile = (file, args, options) =>
  new Promise((resolve, reject) => {
    nodeExecFile(file, [...args], options, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(stdout);
    });
  });

export function createSwayCommandRunner(
  input: CreateSwayCommandRunnerInput = {},
): SwayCommandRunner | null {
  const platform = input.platform ?? process.platform;
  const env = input.env ?? process.env;
  if (platform !== "linux" || !env.SWAYSOCK?.trim()) {
    return null;
  }

  const execFile = input.execFile ?? defaultExecFile;
  const run = (args: readonly string[]) =>
    execFile("swaymsg", args, {
      encoding: "utf8",
      env,
      maxBuffer: SWAY_TREE_MAX_BUFFER_BYTES,
      timeout: SWAY_COMMAND_TIMEOUT_MS,
      windowsHide: true,
    });

  return {
    async getTree(): Promise<unknown> {
      return JSON.parse(await run(["-t", "get_tree"]));
    },
    async setUrgent(containerId: number, active: boolean): Promise<void> {
      if (!Number.isSafeInteger(containerId) || containerId <= 0) {
        throw new Error(`Invalid Sway container id: ${containerId}`);
      }
      const response = JSON.parse(
        await run([`[con_id=${containerId}]`, "urgent", active ? "enable" : "disable"]),
      );
      if (
        !Array.isArray(response) ||
        response.length === 0 ||
        response.some((result) => !isRecord(result) || result.success !== true)
      ) {
        throw new Error(`Sway rejected urgency update for container ${containerId}`);
      }
    },
  };
}

interface SwayWindowAttentionControllerInput {
  runner: SwayCommandRunner;
  expectedPid?: number;
  warn?: (message: string, error: unknown) => void;
}

export class SwayWindowAttentionController {
  private readonly runner: SwayCommandRunner;
  private readonly expectedPid: number;
  private readonly warn: (message: string, error: unknown) => void;
  private readonly containerIds = new Map<number, number>();
  private readonly desiredByWindow = new Map<number, boolean>();
  private readonly captureVersions = new Map<number, number>();
  private readonly operationVersions = new Map<number, number>();
  private queue: Promise<void> = Promise.resolve();
  private didWarn = false;
  private focusCaptureVersion = 0;

  constructor(input: SwayWindowAttentionControllerInput) {
    this.runner = input.runner;
    this.expectedPid = input.expectedPid ?? process.pid;
    this.warn = input.warn ?? console.warn;
  }

  async captureFocusedContainer(windowId: number): Promise<void> {
    const focusCaptureVersion = ++this.focusCaptureVersion;
    const captureVersion = (this.captureVersions.get(windowId) ?? 0) + 1;
    this.captureVersions.set(windowId, captureVersion);

    try {
      const tree = await this.runner.getTree();
      if (
        this.focusCaptureVersion !== focusCaptureVersion ||
        this.captureVersions.get(windowId) !== captureVersion
      ) {
        return;
      }

      const containerId = findFocusedSwayContainerId(tree, this.expectedPid);
      if (containerId === null) {
        return;
      }

      this.containerIds.set(windowId, containerId);
      const desired = this.desiredByWindow.get(windowId);
      if (desired !== undefined) {
        this.enqueueLatest(windowId, containerId, desired);
      }
    } catch (error) {
      this.warnOnce("[sway-attention] Failed to identify the focused Paseo window", error);
    }
  }

  setAttention(windowId: number, active: boolean): void {
    this.desiredByWindow.set(windowId, active);
    const containerId = this.containerIds.get(windowId);
    if (containerId !== undefined) {
      this.enqueueLatest(windowId, containerId, active);
    }
  }

  forgetWindow(windowId: number): void {
    this.captureVersions.set(windowId, (this.captureVersions.get(windowId) ?? 0) + 1);
    this.operationVersions.set(windowId, (this.operationVersions.get(windowId) ?? 0) + 1);
    this.desiredByWindow.delete(windowId);
    const containerId = this.containerIds.get(windowId);
    this.containerIds.delete(windowId);
    if (containerId !== undefined) {
      this.enqueue(async () => {
        await this.runner.setUrgent(containerId, false);
      });
    }
  }

  async flush(): Promise<void> {
    await this.queue;
  }

  private enqueueLatest(windowId: number, containerId: number, active: boolean): void {
    const operationVersion = (this.operationVersions.get(windowId) ?? 0) + 1;
    this.operationVersions.set(windowId, operationVersion);
    this.enqueue(async () => {
      if (
        this.operationVersions.get(windowId) !== operationVersion ||
        this.containerIds.get(windowId) !== containerId ||
        this.desiredByWindow.get(windowId) !== active
      ) {
        return;
      }
      await this.runner.setUrgent(containerId, active);
    });
  }

  private enqueue(operation: () => Promise<void>): void {
    this.queue = this.queue.then(operation).catch((error) => {
      this.warnOnce("[sway-attention] Failed to update Sway urgency", error);
    });
  }

  private warnOnce(message: string, error: unknown): void {
    if (this.didWarn) {
      return;
    }
    this.didWarn = true;
    this.warn(message, error);
  }
}
