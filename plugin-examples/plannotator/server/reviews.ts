import { spawn, execFile, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { PaseoAgentHandle } from "@getpaseo/client";
import { reviewState, type ReviewState } from "../shared/review";
import { decision, reviewUrl } from "./contract";
const exec = promisify(execFile);
interface ReviewApi {
  agents: {
    ref(
      id: string,
    ): Pick<PaseoAgentHandle, "refresh" | "workspaceId" | "archivedAt" | "cwd" | "send">;
  };
}
const active = new Set<ReviewState["status"]>([
  "starting",
  "reviewing",
  "sending",
  "delivery-failed",
]);
export function createReviews(environment: NodeJS.ProcessEnv = process.env) {
  const records = new Map<string, ReviewState>();
  const children = new Map<string, ChildProcess>();
  const starting = new Map<string, Promise<ReviewState>>();
  const writes = new Map<string, Promise<void>>();
  const directory = join(
    environment.PASEO_HOME ?? join(homedir(), ".paseo"),
    "plugin-data",
    "plannotator",
  );
  let stopped = false;
  function file(agentId: string) {
    return join(directory, `${encodeURIComponent(agentId)}.json`);
  }
  function save(state: ReviewState): Promise<void> {
    const content = JSON.stringify(state);
    const previous = writes.get(state.agentId) ?? Promise.resolve();
    const task = previous
      .catch(() => {})
      .then(async () => {
        await mkdir(directory, { recursive: true });
        const temporary = `${file(state.agentId)}.${randomUUID()}.tmp`;
        await writeFile(temporary, content, { mode: 0o600 });
        await rename(temporary, file(state.agentId));
        return undefined;
      });
    writes.set(state.agentId, task);
    return task;
  }
  async function get(agentId: string, workspaceId: string) {
    let state = records.get(agentId);
    if (!state) {
      try {
        state = reviewState.parse(JSON.parse(await readFile(file(agentId), "utf8")));
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
        throw error;
      }
      if (state.status === "sending") {
        state.status = "delivery-failed";
        state.error = "Delivery outcome unknown after restart. Check the agent before retrying.";
      } else if (state.status === "starting" || state.status === "reviewing") {
        state.status = "failed";
        state.url = null;
        state.error = "Review interrupted by plugin restart.";
      }
      records.set(agentId, state);
    }
    if (state.workspaceId !== workspaceId) return null;
    return state;
  }
  async function deliver(state: ReviewState, paseo: ReviewApi) {
    state.status = "sending";
    state.error = null;
    await save(state);
    try {
      if (stopped) throw new Error("Plugin stopped before delivery");
      const agent = paseo.agents.ref(state.agentId);
      await agent.refresh();
      if (agent.workspaceId !== state.workspaceId || agent.archivedAt)
        throw new Error("Original agent is unavailable in this workspace");
      if (!state.message) throw new Error("Review has no message to deliver");
      await agent.send(state.message, { messageId: state.id });
      state.status = "sent";
    } catch (error) {
      state.status = "delivery-failed";
      state.error = `Delivery failed or outcome unknown. Check the agent before retrying. ${String(error)}`;
    }
    await save(state);
    return state;
  }
  async function launch(agentId: string, workspaceId: string, paseo: ReviewApi) {
    const previous = await get(agentId, workspaceId);
    if (previous && active.has(previous.status)) return previous;
    const agent = paseo.agents.ref(agentId);
    await agent.refresh();
    if (!agent.cwd || agent.workspaceId !== workspaceId || agent.archivedAt)
      throw new Error("Agent is unavailable in this workspace");
    await exec("git", ["rev-parse", "--show-toplevel"], { cwd: agent.cwd, timeout: 5000 });
    if (stopped) throw new Error("Plugin is stopping");
    const state: ReviewState = {
      id: randomUUID(),
      agentId,
      workspaceId,
      status: "starting",
      url: null,
      message: null,
      error: null,
    };
    records.set(agentId, state);
    const env: NodeJS.ProcessEnv = {
      ...environment,
      PLANNOTATOR_REMOTE: "0",
      PLANNOTATOR_BROWSER: "none",
    };
    delete env.PLANNOTATOR_PORT;
    const child = spawn(
      "plannotator",
      ["review", "--json", "--git", "--diff-type", "uncommitted", "--no-git-remote-check"],
      { cwd: agent.cwd, env, shell: false, stdio: ["ignore", "pipe", "pipe"] },
    );
    children.set(state.id, child);
    let output = "";
    let diagnostics = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      if (output.length > 8 * 1024 * 1024) {
        state.error = "Review output exceeded 8 MiB";
        child.kill();
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      diagnostics = (diagnostics + chunk.toString()).slice(-16000);
    });
    child.on("error", (error) => {
      state.error = error.message;
    });
    child.on("close", (code) => {
      children.delete(state.id);
      void finish(code).catch((error) => {
        state.status = "failed";
        state.error = String(error);
        void save(state).catch(() => {
          state.error = `${state.error}; result could not be saved`;
        });
      });
    });
    async function finish(code: number | null) {
      state.url = null;
      if (state.status === "cancelled" || state.status === "failed" || stopped) return;
      if (code !== 0 || state.error) {
        state.status = "failed";
        state.error = state.error ?? (diagnostics || `Plannotator exited ${code}`);
        await save(state);
        return;
      }
      const result = decision.parse(JSON.parse(output));
      if (result.decision === "dismissed") {
        state.status = "cancelled";
        await save(state);
        return;
      }
      state.message = result.message;
      await deliver(state, paseo);
    }
    for (let attempt = 0; attempt < 60 && state.status === "starting"; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      if (state.status !== "starting" || stopped) break;
      try {
        const result = await exec("plannotator", ["sessions", "--json"], {
          env,
          timeout: 3000,
          maxBuffer: 1024 * 1024,
        });
        const url = reviewUrl(result.stdout, child.pid ?? -1);
        if (url && state.status === "starting") {
          state.url = url;
          state.status = "reviewing";
        }
      } catch (error) {
        state.error = String(error);
        break;
      }
    }
    if (state.status === "starting") {
      state.status = "failed";
      state.error = state.error ?? "Timed out waiting for the review URL";
      child.kill();
    }
    if (state.status === "reviewing" || state.status === "failed") await save(state);
    return state;
  }
  function start(agentId: string, workspaceId: string, paseo: ReviewApi) {
    const pending = starting.get(agentId);
    if (pending)
      return pending.then((state) => {
        if (state.workspaceId !== workspaceId)
          throw new Error("Review belongs to another workspace");
        return state;
      });
    const task = launch(agentId, workspaceId, paseo).finally(() => starting.delete(agentId));
    starting.set(agentId, task);
    return task;
  }
  async function operate(
    agentId: string,
    workspaceId: string,
    id: string,
    retry: boolean,
    paseo: ReviewApi,
  ) {
    const state = await get(agentId, workspaceId);
    if (!state || state.id !== id) throw new Error("Review is no longer current");
    if (retry) {
      if (state.status !== "delivery-failed") throw new Error("This review cannot be retried");
      return deliver(state, paseo);
    }
    if (state.status !== "starting" && state.status !== "reviewing")
      throw new Error("This review cannot be cancelled");
    state.status = "cancelled";
    state.url = null;
    const child = children.get(id);
    if (child) {
      const timer = setTimeout(() => child.kill("SIGKILL"), 2000);
      child.once("close", () => clearTimeout(timer));
      child.kill();
    }
    await save(state);
    return state;
  }
  async function stop() {
    stopped = true;
    await Promise.all(
      [...children.values()].map(async (child) => {
        const closed = once(child, "close");
        const timer = setTimeout(() => child.kill("SIGKILL"), 2000);
        child.kill();
        try {
          await closed;
        } finally {
          clearTimeout(timer);
        }
      }),
    );
  }
  return { get, start, operate, stop };
}
