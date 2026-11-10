import { mkdir, readFile, rename, writeFile, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import { reviewState, type ReviewState } from "../shared/review";
import type { ReviewStore } from "./ports";
const legacy = z.object({
  id: z.string(),
  agentId: z.string(),
  workspaceId: z.string(),
  status: z.string(),
  message: z.string().nullable(),
  error: z.string().nullable(),
});
async function json(path: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}
async function atomic(path: string, content: string) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, content, { mode: 0o600 });
  await rename(temporary, path);
}
export function createStore(root: string): ReviewStore {
  const writes = new Map<string, Promise<void>>();
  const directory = (id: string, revision: string) =>
    join(root, "reviews", encodeURIComponent(id), "revisions", encodeURIComponent(revision));
  const store: ReviewStore = {
    directory,
    async save(state) {
      const content = JSON.stringify(reviewState.parse(state));
      const task = (writes.get(state.agentId) ?? Promise.resolve()).then(async () => {
        const reviewDirectory = join(root, "reviews", encodeURIComponent(state.id));
        await mkdir(reviewDirectory, { recursive: true, mode: 0o700 });
        await mkdir(join(root, "agents"), { recursive: true, mode: 0o700 });
        await atomic(join(reviewDirectory, "review.json"), content);
        await atomic(
          join(root, "agents", `${encodeURIComponent(state.agentId)}.json`),
          JSON.stringify({ reviewId: state.id }),
        );
        return undefined;
      });
      writes.set(
        state.agentId,
        task.catch(() => {}),
      );
      await task;
    },
    async find(agentId) {
      const index = await json(join(root, "agents", `${encodeURIComponent(agentId)}.json`));
      if (index !== null) {
        const { reviewId } = z.object({ reviewId: z.string() }).parse(index);
        return reviewState.parse(
          await json(join(root, "reviews", encodeURIComponent(reviewId), "review.json")),
        );
      }
      const old = await json(join(root, `${encodeURIComponent(agentId)}.json`));
      if (old === null) return null;
      const record = legacy.parse(old);
      const state: ReviewState = {
        version: 2,
        id: record.id,
        agentId: record.agentId,
        workspaceId: record.workspaceId,
        workspaceName: record.workspaceId,
        agentName: record.agentId,
        cwd: "",
        revisionId: "legacy",
        status: "paused",
        liveRevisionId: null,
        url: null,
        error: "Legacy uncommitted review; create a new snapshot to reopen.",
        revisions: [
          {
            id: "legacy",
            createdAt: new Date().toISOString(),
            selection: { mode: "working-copy" },
            resolved: null,
            patchHash: null,
            patchPath: null,
            files: [],
            draft: null,
            guides: [],
          },
        ],
        deliveries: [],
      };
      if (record.message) {
        let status: "sent" | "failed" | "unknown" = "unknown";
        if (record.status === "sent") status = "sent";
        if (record.status === "delivery-failed") status = "unknown";
        state.deliveries.push({
          id: record.id,
          revisionId: "legacy",
          agentId,
          text: record.message,
          status,
          error: record.error,
        });
      }
      await store.save(state);
      return state;
    },
    async patch(id, revision, content) {
      const folder = directory(id, revision);
      await mkdir(folder, { recursive: true, mode: 0o700 });
      const path = join(folder, "review.patch");
      await writeFile(path, content, { flag: "wx", mode: 0o600 });
      return path;
    },
    async request(id, revision, requestId, content) {
      const folder = join(directory(id, revision), "requests", encodeURIComponent(requestId));
      await mkdir(folder, { recursive: true, mode: 0o700 });
      const input = join(folder, "request.json");
      await atomic(input, content);
      return { input, output: join(folder, "guide.json") };
    },
    async readGuide(path) {
      try {
        const info = await stat(path);
        if (!info.isFile() || info.size > 4 * 1024 * 1024)
          throw new Error("Guide result must be a JSON file smaller than 4 MiB");
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
        throw error;
      }
      return json(path);
    },
  };
  return store;
}
