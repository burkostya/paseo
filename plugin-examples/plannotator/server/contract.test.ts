import { describe, expect, it } from "vitest";
import { z } from "zod";
import { cliVersion, decision, reviewUrl, sessions as sessionList } from "./contract";
describe("Plannotator 0.28.53 contract", () => {
  it("selects the review belonging to the child PID", () => {
    const raw = JSON.stringify([
      { pid: 1, mode: "review", url: "http://localhost:1111" },
      { pid: 2, mode: "review", url: "http://localhost:32941" },
    ]);
    expect(reviewUrl(raw, 2)).toBe("http://localhost:32941/");
    expect(reviewUrl(raw, 3)).toBeNull();
  });
  it("rejects remote and non-http URLs", () => {
    for (const url of ["http://example.com:1234", "https://localhost:1234", "file:///tmp/review"]) {
      expect(() => reviewUrl(JSON.stringify([{ pid: 2, mode: "review", url }]), 2)).toThrow();
    }
  });
  it("preserves feedback and distinguishes dismissal", () => {
    expect(
      decision.parse({ decision: "annotated", message: "Paseo contract test\n" }).message,
    ).toBe("Paseo contract test\n");
    expect(decision.parse({ decision: "dismissed", message: "" }).decision).toBe("dismissed");
    expect(() => decision.parse({ feedback: "legacy" })).toThrow();
  });
});

import { afterEach, beforeEach, vi } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { promisify } from "node:util";
import { createReviews, coverage } from "./reviews";
import { createEngine } from "./engine";
import { openReviewForm } from "../client/model";
import { createStore } from "./store";
import { manifest } from "./source";
import type { ReviewPorts, EngineState } from "./ports";
import { revision as revisionSchema, type ReviewState, type Target } from "../shared/review";
import type { VcsResolvedComparison } from "@getpaseo/plugin";

describe("review lifecycle", () => {
  let root: string;
  let reviews: ReturnType<typeof createReviews>;
  let ports: ReviewPorts;
  let patch: string;
  let busy: boolean;
  let failSend: boolean;
  const target = { agentId: "a", workspaceId: "workspace" };
  const sends: { target: Target; text: string; messageId: string }[] = [];
  const opened: {
    stopped: boolean;
    state: EngineState;
    finish: (result: z.infer<typeof decision> | null) => void;
    fail: (error: Error) => void;
    readError: Error | null;
  }[] = [];
  const resolved: VcsResolvedComparison = {
    comparison: { kind: "range", from: "base", to: "head" },
    description: "base → task",
    baseRef: "base",
    baseRevision: "base",
    mergeBaseRevision: "base",
    headRevision: "head",
    sourceUrl: null,
  };
  function diff(name: string, value: string) {
    return `diff --git a/${name} b/${name}\n--- a/${name}\n+++ b/${name}\n@@ -1 +1 @@\n-before\n+${value}\n`;
  }
  function operation(state: ReviewState) {
    return { ...target, reviewId: state.id, revisionId: state.revisionId };
  }
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "paseo-review-test-"));
    patch = diff("one.txt", "after") + diff("two.txt", "new");
    busy = false;
    failSend = false;
    sends.length = 0;
    opened.length = 0;
    ports = {
      store: createStore(root),
      conversation: {
        catalog: async () => ({ profiles: [], providers: [] }),
        startHelper: async () => {},
        helperState: async () => "running",
        stopHelper: async () => {},
        inspect: async () => ({ cwd: root, name: "Task agent", busy }),
        async send(recipient, text, messageId) {
          if (failSend) throw new Error("connection lost");
          sends.push({ target: recipient, text, messageId });
        },
      },
      source: {
        prepare: async () => ({
          cwd: root,
          workspaceName: "Task workspace",
          agentName: "Task agent",
          agentBusy: busy,
          refs: [],
          resolved,
          error: null,
        }),
        snapshot: async () => ({ resolved, patch, files: manifest(patch) }),
      },
      engine: {
        async open({ revision }) {
          let finish!: (result: z.infer<typeof decision> | null) => void;
          let fail!: (error: Error) => void;
          const result = new Promise<z.infer<typeof decision> | null>((resolve, reject) => {
            finish = resolve;
            fail = reject;
          });
          const engineState: EngineState = { draft: revision.draft, guides: [] };
          const entry: (typeof opened)[number] = {
            stopped: false,
            state: engineState,
            finish,
            fail,
            readError: null,
          };
          opened.push(entry);
          return {
            url: `http://localhost:${20000 + opened.length}/`,
            result,
            async read() {
              if (entry.readError) throw entry.readError;
              return entry.state;
            },
            async importGuide(document) {
              const id = `guide-${entry.state.guides.length}`;
              entry.state.guides.push({
                id,
                document,
                reviewed: document.sections.map(() => false),
              });
              return id;
            },
            async stop() {
              entry.stopped = true;
              finish(null);
            },
          };
        },
      },
    };
    reviews = createReviews(ports);
  });
  afterEach(async () => {
    await reviews.stop();
    await rm(root, { recursive: true, force: true });
  });
  it("coalesces launches and delivers only to the original agent", async () => {
    const [first, duplicate] = await Promise.all([
      reviews.start(target, { mode: "task" }),
      reviews.start(target, { mode: "task" }),
    ]);
    expect(first.id).toBe(duplicate.id);
    expect(opened).toHaveLength(1);
    await reviews.start({ ...target, agentId: "b" }, { mode: "task" });
    opened[0].finish({ decision: "annotated", message: "Check this line" });
    await vi.waitFor(async () =>
      expect((await reviews.get(target))?.deliveries[0].status).toBe("sent"),
    );
    expect(sends).toHaveLength(1);
    expect(sends[0].target.agentId).toBe("a");
    expect(sends[0].text).toContain("HEAD: head");
    expect(sends[0].text).toContain("Check this line");
    expect((await reviews.get({ ...target, agentId: "b" }))?.status).toBe("reviewing");
  });
  it("cancels only the dedicated Guide agent and ignores its late output", async () => {
    const started: string[] = [];
    const stopped: string[] = [];
    ports.conversation.startHelper = async (_target, helper) => {
      started.push(helper.agentId);
    };
    ports.conversation.stopHelper = async (owner) => {
      expect(owner.requestId).toBeTruthy();
      expect(owner.workspaceId).toBe(target.workspaceId);
      expect(owner.taskAgentId).toBe(target.agentId);
      stopped.push(owner.agentId);
    };
    const state = await reviews.start(target, { mode: "task" });
    await reviews.requestGuide(operation(state), { provider: "pi", model: "small" });
    const guide = state.revisions[0].guides[0];
    expect(guide.source).toBe("paseo-helper");
    expect(started).toEqual([guide.helper?.agentId]);
    expect(sends).toEqual([]);
    await reviews.cancelGuide(operation(state), guide.requestId!);
    expect(stopped).toEqual(started);
    expect(guide.status).toBe("cancelled");
  });
  it("imports a dedicated agent's Guide after its turn finishes and archives it", async () => {
    const archived: string[] = [];
    let finished = false;
    ports.conversation.helperState = async () => (finished ? "finished" : "running");
    ports.conversation.stopHelper = async (owner, cancel) => {
      expect(cancel).toBe(false);
      archived.push(owner.agentId);
    };
    const state = await reviews.start(target, { mode: "task" });
    await reviews.requestGuide(operation(state), { provider: "codex", model: "small" });
    const revision = state.revisions[0];
    const guide = revision.guides[0];
    const output = join(
      ports.store.directory(state.id, revision.id),
      "requests",
      guide.requestId!,
      "guide.json",
    );
    await writeFile(
      output,
      JSON.stringify({
        requestId: guide.requestId,
        revisionId: revision.id,
        patchHash: revision.patchHash,
        guide: {
          title: "Guide",
          intent: "Review",
          sections: [
            { title: "One", overview: "Read", diffs: [{ file: "one.txt", summary: "Changed" }] },
          ],
        },
        outsideSections: ["two.txt"],
      }),
    );
    finished = true;
    await vi.waitFor(() => expect(guide.status).toBe("ready"), { timeout: 4000 });
    expect(archived).toEqual([guide.helper!.agentId]);
    expect(sends).toEqual([]);
  });
  it("coalesces helper requests and recovers its persisted id without creating again", async () => {
    const started: string[] = [];
    ports.conversation.startHelper = async (_target, helper) => {
      started.push(helper.agentId);
    };
    const state = await reviews.start(target, { mode: "task" });
    const selection = { provider: "codex", model: "small", profileId: "reviewer" };
    const attempts = await Promise.allSettled([
      reviews.requestGuide(operation(state), selection),
      reviews.requestGuide(operation(state), selection),
    ]);
    expect(attempts.map((item) => item.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(started).toHaveLength(1);
    const persisted = structuredClone(state);
    await reviews.stop();
    await ports.store.save(persisted); // State left by a crash before graceful cleanup.
    reviews = createReviews(ports);
    await reviews.get(target);
    await expect(reviews.requestGuide(operation(state), selection)).rejects.toThrow(
      "already pending",
    );
    expect(started).toHaveLength(1);
    ports.conversation.helperState = async (owner) => {
      expect(owner.agentId).toBe(started[0]);
      expect(owner.requestId).toBe(persisted.revisions[0].guides[0].requestId);
      return "finished";
    };
    await vi.waitFor(
      async () => expect((await reviews.get(target))?.revisions[0].guides[0].status).toBe("failed"),
      { timeout: 4000 },
    );
    expect(started).toHaveLength(1);
    expect(sends).toEqual([]);
  });
  it("reconciles uncertain helper creation without sending another creation request", async () => {
    let starts = 0;
    ports.conversation.startHelper = async () => {
      starts++;
      throw new Error("response lost");
    };
    const state = await reviews.start(target, { mode: "task" });
    await reviews.requestGuide(operation(state), { provider: "codex", model: "small" });
    expect(state.revisions[0].guides[0].status).toBe("pending");
    expect(state.revisions[0].guides[0].error).toContain("response lost");
    await expect(
      reviews.requestGuide(operation(state), { provider: "codex", model: "small" }),
    ).rejects.toThrow("already pending");
    await reviews.cancelGuide(operation(state), state.revisions[0].guides[0].requestId!);
    expect(starts).toBe(1);
    expect(sends).toEqual([]);
  });
  it("preserves the snapshot after launch failure and supports reopening", async () => {
    const open = ports.engine.open;
    ports.engine.open = async () => {
      throw new Error("Plannotator CLI is not installed on PATH");
    };
    await expect(reviews.start(target, { mode: "task" })).rejects.toThrow("not installed");
    const state = (await reviews.get(target))!;
    expect(state.status).toBe("failed");
    expect(state.error).toContain("not installed");
    expect(state.revisions[0].files.map((file) => file.path)).toEqual(["one.txt", "two.txt"]);
    expect(sends).toEqual([]);
    ports.engine.open = open;
    await reviews.open(operation(state));
    expect(state.status).toBe("reviewing");
    expect(state.error).toBeNull();
  });
  it("reports an engine crash without sending feedback or affecting another agent", async () => {
    await reviews.start(target, { mode: "task" });
    const other = { ...target, agentId: "b" };
    await reviews.start(other, { mode: "task" });
    opened[0].fail(new Error("Plannotator exited 1: invalid review response"));
    await vi.waitFor(async () => expect((await reviews.get(target))?.status).toBe("failed"));
    expect((await reviews.get(target))?.error).toContain("invalid review response");
    expect((await reviews.get(target))?.url).toBeNull();
    expect((await reviews.get(other))?.status).toBe("reviewing");
    expect(opened[1].stopped).toBe(false);
    expect(sends).toEqual([]);
  });
  it("stops owned processes even when their state endpoint has failed", async () => {
    const state = await reviews.start(target, { mode: "task" });
    opened[0].readError = new Error("draft endpoint unavailable");
    await reviews.stop();
    expect(opened[0].stopped).toBe(true);
    expect(state.status).toBe("paused");
    expect(state.error).toContain("draft endpoint unavailable");
    expect(state.url).toBeNull();
    expect(sends).toEqual([]);
  });
  it("preserves unknown delivery across restart and retries only explicitly", async () => {
    failSend = true;
    const state = await reviews.start(target, { mode: "task" });
    opened[0].finish({ decision: "annotated", message: "Saved feedback" });
    await vi.waitFor(async () =>
      expect((await reviews.get(target))?.deliveries[0].status).toBe("unknown"),
    );
    const deliveryId = state.deliveries[0].id;
    await reviews.stop();
    reviews = createReviews(ports);
    failSend = false;
    expect((await reviews.get(target))?.deliveries[0].text).toContain("Saved feedback");
    expect(sends).toHaveLength(0);
    await reviews.retry(operation(state), deliveryId);
    expect(sends).toHaveLength(1);
    expect(state.deliveries[0].status).toBe("unknown");
    expect((await reviews.get(target))?.deliveries[0].status).toBe("sent");
  });
  it("retains feedback when the original agent is unavailable before delivery", async () => {
    const state = await reviews.start(target, { mode: "task" });
    ports.conversation.inspect = async () => {
      throw new Error("Original agent has been archived");
    };
    opened[0].finish({ decision: "annotated", message: "Keep this feedback" });
    await vi.waitFor(async () =>
      expect((await reviews.get(target))?.deliveries[0].status).toBe("failed"),
    );
    expect(state.status).toBe("paused");
    expect(state.deliveries[0].text).toContain("Keep this feedback");
    expect(state.deliveries[0].agentId).toBe(target.agentId);
    expect(state.deliveries[0].error).toContain("archived");
    expect(sends).toEqual([]);
  });
  it("restores viewed state and transfers marks only for identical file diffs", async () => {
    const state = await reviews.start(target, { mode: "task" });
    opened[0].state.draft = {
      codeAnnotations: [{ id: "old-note" }],
      viewedFiles: ["one.txt", "two.txt"],
      ts: 1,
    };
    await reviews.cancel(operation(state));
    await reviews.stop();
    reviews = createReviews(ports);
    const restored = (await reviews.get(target))!;
    await reviews.open(operation(restored));
    expect(opened[1].state.draft?.viewedFiles).toEqual(["one.txt", "two.txt"]);
    const oldRevision = restored.revisionId;
    patch = diff("one.txt", "changed") + diff("two.txt", "new");
    await reviews.update(operation(restored), { mode: "task" });
    expect(restored.revisionId).not.toBe(oldRevision);
    expect(restored.revisions[1].draft?.viewedFiles).toEqual(["two.txt"]);
    expect(restored.revisions[1].draft?.codeAnnotations).toEqual([]);
    expect(restored.revisions[0].draft?.codeAnnotations).toEqual([{ id: "old-note" }]);
    await expect(
      reviews.cancel({ ...operation(restored), revisionId: oldRevision }),
    ).rejects.toThrow("revision changed");
    await reviews.update(operation(restored), { mode: "task" });
    expect(restored.revisions).toHaveLength(2);
  });
  it("cancels only owned processes and never delivers a dismissal", async () => {
    const state = await reviews.start(target, { mode: "task" });
    await expect(reviews.cancel({ ...operation(state), reviewId: "old" })).rejects.toThrow(
      "revision changed",
    );
    await reviews.cancel(operation(state));
    expect(opened[0].stopped).toBe(true);
    expect(sends).toHaveLength(0);
    await reviews.open(operation(state));
    opened[1].finish({ decision: "dismissed", message: "" });
    await vi.waitFor(async () => expect((await reviews.get(target))?.status).toBe("paused"));
    expect(sends).toHaveLength(0);
  });
  it("validates Guide paths, retains uncovered files and ignores late cancelled output", async () => {
    const state = await reviews.start(target, { mode: "task" });
    busy = true;
    await expect(reviews.requestGuide(operation(state))).rejects.toThrow("busy");
    busy = false;
    await reviews.requestGuide(operation(state));
    const rev = state.revisions[0];
    const pending = rev.guides[0];
    const document = {
      title: "Behavior",
      intent: "Read behavior first",
      sections: [
        {
          title: "First",
          overview: "Check one",
          diffs: [{ file: "one.txt", summary: "Change behavior" }],
        },
      ],
    };
    expect(coverage(document, rev)).toEqual(["two.txt"]);
    expect(() =>
      coverage(
        {
          ...document,
          sections: [{ ...document.sections[0], diffs: [{ file: "missing", summary: "wrong" }] }],
        },
        rev,
      ),
    ).toThrow("outside");
    const output = join(
      ports.store.directory(state.id, rev.id),
      "requests",
      pending.requestId!,
      "guide.json",
    );
    await reviews.cancelGuide(operation(state), pending.requestId!);
    await writeFile(
      output,
      JSON.stringify({
        requestId: pending.requestId,
        revisionId: rev.id,
        patchHash: rev.patchHash,
        guide: document,
        outsideSections: ["two.txt"],
      }),
    );
    await reviews.requestGuide(operation(state));
    const next = rev.guides[1];
    await writeFile(
      join(ports.store.directory(state.id, rev.id), "requests", next.requestId!, "guide.json"),
      JSON.stringify({
        requestId: next.requestId,
        revisionId: rev.id,
        patchHash: rev.patchHash,
        guide: document,
        outsideSections: ["two.txt"],
      }),
    );
    await vi.waitFor(() => expect(next.status).toBe("ready"), { timeout: 4000 });
    expect(pending.status).toBe("cancelled");
    expect(opened[0].state.guides).toHaveLength(1);
    expect(next.uncovered).toEqual(["two.txt"]);
    expect(sends.map((item) => item.target.agentId)).toEqual(["a", "a"]);
  });
  it("reimports a saved failed Guide after reopening without another agent message", async () => {
    const state = await reviews.start(target, { mode: "task" });
    await reviews.requestGuide(operation(state));
    const revision = state.revisions[0];
    const guide = revision.guides[0];
    const path = join(
      ports.store.directory(state.id, revision.id),
      "requests",
      guide.requestId!,
      "guide.json",
    );
    guide.status = "failed";
    guide.error = "Error: Could not identify imported Guide";
    await ports.store.save(state);
    const response = {
      requestId: guide.requestId,
      revisionId: revision.id,
      patchHash: revision.patchHash,
      guide: {
        title: "Saved task Guide",
        intent: "Review",
        sections: [
          { title: "One", overview: "Read", diffs: [{ file: "one.txt", summary: "Changed" }] },
        ],
      },
      outsideSections: ["two.txt"],
    };
    await writeFile(path, JSON.stringify(response));
    await reviews.stop();
    reviews = createReviews(ports);
    await expect(
      reviews.retryGuideImport({ ...operation(state), revisionId: "old" }, guide.requestId!),
    ).rejects.toThrow("changed");
    busy = true; // Import never sends another message or interrupts the agent.
    const recovered = await reviews.retryGuideImport(operation(state), guide.requestId!);
    expect(recovered.revisions[0].guides[0]).toMatchObject({
      status: "ready",
      error: null,
      document: response.guide,
      uncovered: ["two.txt"],
    });
    expect(opened[1].state.guides).toHaveLength(1);
    expect(sends).toHaveLength(1);
    await expect(reviews.retryGuideImport(operation(state), guide.requestId!)).rejects.toThrow(
      "Only a failed",
    );
  });
  it("revalidates saved Guide identity on import retry and rejects cancelled requests", async () => {
    const state = await reviews.start(target, { mode: "task" });
    await reviews.requestGuide(operation(state));
    const revision = state.revisions[0];
    const guide = revision.guides[0];
    await reviews.cancelGuide(operation(state), guide.requestId!);
    await expect(reviews.retryGuideImport(operation(state), guide.requestId!)).rejects.toThrow(
      "Only a failed",
    );
    guide.status = "failed";
    await expect(reviews.retryGuideImport(operation(state), guide.requestId!)).rejects.toThrow(
      "No saved",
    );
    await writeFile(
      join(
        ports.store.directory(state.id, revision.id),
        "requests",
        guide.requestId!,
        "guide.json",
      ),
      JSON.stringify({
        requestId: "another-request",
        revisionId: revision.id,
        patchHash: revision.patchHash,
        guide: {
          title: "Wrong",
          intent: "Review",
          sections: [
            { title: "One", overview: "Read", diffs: [{ file: "one.txt", summary: "Changed" }] },
          ],
        },
        outsideSections: ["two.txt"],
      }),
    );
    const result = await reviews.retryGuideImport(operation(state), guide.requestId!);
    expect(result.revisions[0].guides[0]).toMatchObject({
      status: "failed",
      error: expect.stringContaining("another request"),
    });
    expect(opened[0].state.guides).toEqual([]);
    expect(sends).toHaveLength(1);
  });
  it("can reopen an older revision without changing the feedback recipient or current revision", async () => {
    const state = await reviews.start(target, { mode: "task" });
    const first = state.revisionId;
    patch = diff("one.txt", "changed") + diff("two.txt", "new");
    await reviews.update(operation(state), { mode: "task", baseRef: "another-base" });
    const current = state.revisionId;
    await reviews.open(operation(state), first);
    expect(state.liveRevisionId).toBe(first);
    expect(state.revisionId).toBe(current);
    expect(opened[1].stopped).toBe(true);
    opened[2].finish({ decision: "annotated", message: "Historical feedback" });
    await vi.waitFor(async () =>
      expect((await reviews.get(target))?.deliveries[0].status).toBe("sent"),
    );
    expect(state.deliveries[0].revisionId).toBe(first);
    expect(sends[0].target.agentId).toBe("a");
  });
  it("keeps form selections local when remote review state changes", () => {
    const model = openReviewForm(null);
    model.setBase("refs/heads/task-base");
    model.applyReview(null);
    expect(model.getState().selection).toEqual({ mode: "task", baseRef: "refs/heads/task-base" });
    model.setMode("change-request");
    expect(model.getState().selection).toEqual({ mode: "change-request" });
    model.close();
  });
  it("keeps renamed, deleted, binary and quoted paths in the complete manifest", () => {
    const entries = manifest(
      'diff --git a/old name b/new name\nsimilarity index 100%\nrename from old name\nrename to new name\ndiff --git a/gone b/gone\ndeleted file mode 100644\nBinary files a/gone and /dev/null differ\ndiff --git "a/\\320\\260.txt" "b/\\320\\260.txt"\nBinary files differ\n',
    );
    expect(entries.map(({ path, kind }) => ({ path, kind }))).toEqual([
      { path: "new name", kind: "renamed" },
      { path: "gone", kind: "deleted" },
      { path: "а.txt", kind: "binary" },
    ]);
    expect(manifest("diff --git a/a b/z b/a b/z\nindex abc..def 100644\n")[0]).toMatchObject({
      path: "a b/z",
      oldPath: "a b/z",
      kind: "modified",
    });
    expect(entries[0].oldPath).toBe("old name");
    expect(entries.every((entry) => entry.fingerprint.length === 64)).toBe(true);
  });
  it("migrates legacy feedback without inventing revision SHAs", async () => {
    await writeFile(
      join(root, "legacy-agent.json"),
      JSON.stringify({
        id: "legacy-review",
        agentId: "legacy-agent",
        workspaceId: "workspace",
        status: "delivery-failed",
        message: "Keep this feedback",
        error: "lost",
      }),
    );
    const state = (await reviews.get({ ...target, agentId: "legacy-agent" }))!;
    expect(state.revisions[0].resolved).toBeNull();
    expect(state.deliveries[0]).toMatchObject({ text: "Keep this feedback", status: "unknown" });
  });
});

// Opt in explicitly: this starts the separately installed CLI, with isolated data
// and no browser, hooks, provider calls or modifications to the user's repository.
describe.runIf(process.env.PASEO_PLANNOTATOR_CONTRACT === "1")(
  "installed CLI snapshot contract",
  () => {
    const exec = promisify(execFile);
    const guideList = z.array(z.object({ id: z.string(), title: z.string() }));
    let root: string;
    let child: ChildProcess | undefined;
    let closed: Promise<unknown> | undefined;
    let diagnostics = "";
    let output = "";
    let url: string;
    let env: NodeJS.ProcessEnv;

    async function stop() {
      if (!child) return;
      const process = child;
      child = undefined;
      if (process.exitCode === null && process.signalCode === null) process.kill();
      const timer = setTimeout(() => process.kill("SIGKILL"), 2000);
      try {
        await closed;
      } finally {
        clearTimeout(timer);
      }
    }

    async function launch() {
      diagnostics = "";
      output = "";
      const process = spawn(
        "plannotator",
        ["review", "--json", "--patch-file", join(root, "review.patch"), "--no-git-remote-check"],
        { cwd: root, env, shell: false, stdio: ["ignore", "pipe", "pipe"] },
      );
      child = process;
      // Attach before polling so even an early exit is observed and cleaned up.
      closed = new Promise<void>((resolve) => process.once("close", () => resolve()));
      let failure: Error | undefined;
      process.on("error", (error) => {
        failure = error;
      });
      process.stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString();
      });
      process.stderr.on("data", (chunk: Buffer) => {
        diagnostics = (diagnostics + chunk.toString()).slice(-16000);
      });
      await vi.waitFor(
        async () => {
          if (failure) throw failure;
          if (process.exitCode !== null) throw new Error(`Plannotator exited: ${diagnostics}`);
          const result = await exec("plannotator", ["sessions", "--json"], { env, timeout: 3000 });
          const found = reviewUrl(result.stdout, process.pid ?? -1);
          expect(found, diagnostics).not.toBeNull();
          url = found!;
        },
        { timeout: 20000, interval: 200 },
      );
    }

    async function request(path: string, method = "GET", data?: unknown) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      try {
        const response = await fetch(new URL(path, url), {
          method,
          headers: { "Content-Type": "application/json" },
          ...(data === undefined ? {} : { body: JSON.stringify(data) }),
          signal: controller.signal,
        });
        expect(response.status, `${method} ${path}`).toBe(200);
        return (await response.json()) as unknown;
      } finally {
        clearTimeout(timer);
      }
    }

    afterEach(async () => {
      await stop();
      if (root) await rm(root, { recursive: true, force: true });
    });

    it("restores patch, draft comments, viewed files and Guide sections on another port", async () => {
      root = await mkdtemp(join(tmpdir(), "paseo-plannotator-contract-"));
      env = {
        ...process.env,
        PLANNOTATOR_DATA_DIR: join(root, "data"),
        PLANNOTATOR_REMOTE: "0",
        PLANNOTATOR_BROWSER: "none",
      };
      delete env.PLANNOTATOR_PORT;
      expect(
        cliVersion.safeParse((await exec("plannotator", ["--version"], { env })).stdout.trim())
          .success,
      ).toBe(true);
      const git = (...args: string[]) => exec("git", args, { cwd: root });
      await git("init", "--quiet");
      await git("config", "user.name", "Contract Test");
      await git("config", "user.email", "test@example.invalid");
      await writeFile(join(root, "one.txt"), "before\n");
      await git("add", "one.txt");
      await git("commit", "--quiet", "-m", "base");
      const base = (await git("rev-parse", "HEAD")).stdout.trim();
      await writeFile(join(root, "one.txt"), "after\n");
      await writeFile(join(root, "two.txt"), "new file\n");
      await git("add", "one.txt", "two.txt");
      await git("commit", "--quiet", "-m", "task");
      expect((await git("status", "--porcelain", "--untracked-files=no")).stdout).toBe("");
      const patch = (await git("diff", "--binary", base, "HEAD")).stdout;
      await writeFile(join(root, "review.patch"), patch);
      await launch();
      const diff = z
        .object({ rawPatch: z.string(), snapshotId: z.string() })
        .parse(await request("/api/diff"));
      expect(diff.rawPatch).toBe(patch);
      // Static-patch sessions deliberately use the draft fallback, not this API.
      expect(
        await request(`/api/review-progress?snapshot=${encodeURIComponent(diff.snapshotId)}`),
      ).toEqual({ available: false });
      const draft = {
        codeAnnotations: [
          {
            id: "comment-1",
            type: "comment",
            scope: "line",
            filePath: "one.txt",
            lineStart: 1,
            lineEnd: 1,
            side: "new",
            text: "Check this change",
            createdAt: 1,
          },
        ],
        viewedFiles: ["one.txt"],
        autoViewSuppressed: ["two.txt"],
        ts: Date.now(),
      };
      expect(await request("/api/draft", "POST", draft)).toEqual({ ok: true });
      expect(await request("/api/draft")).toMatchObject(draft);
      const guide = {
        title: "Task review",
        intent: "Read behavior before additions",
        sections: [
          {
            title: "Behavior",
            overview: "Check the changed behavior",
            diffs: [{ file: "one.txt", summary: "Replace before with after" }],
          },
        ],
      };
      const guideFile = join(root, "guide.json");
      await writeFile(guideFile, JSON.stringify(guide));
      await exec(
        "plannotator",
        ["guide", "import", "--guide", guideFile, "--patch", join(root, "review.patch")],
        { cwd: root, env, timeout: 10000 },
      );
      const guides = guideList.parse(await request("/api/guides"));
      expect(guides).toHaveLength(1);
      expect(guides[0].title).toBe(guide.title);
      const guidePath = `/api/guide/${encodeURIComponent(`saved:${guides[0].id}`)}`;
      expect(await request(`${guidePath}/reviewed`, "PUT", { reviewed: [true] })).toEqual({
        ok: true,
      });
      expect(await request(guidePath)).toMatchObject({ reviewed: [true] });
      expect(await request("/api/draft")).toMatchObject(draft);
      const firstUrl = new URL(url);
      await stop();
      // Reserve the old port: successful restoration must not rely on its origin.
      const reserved = createServer();
      reserved.listen(Number(firstUrl.port), firstUrl.hostname);
      await once(reserved, "listening");
      try {
        await launch();
      } finally {
        await new Promise<void>((resolve, reject) =>
          reserved.close((error) => {
            if (error) {
              reject(error);
              return;
            }
            resolve();
          }),
        );
      }
      expect(new URL(url).port).not.toBe(firstUrl.port);
      expect(await request("/api/diff")).toMatchObject({ rawPatch: patch });
      expect(await request("/api/draft")).toMatchObject(draft);
      expect(await request(guidePath)).toMatchObject({ reviewed: [true] });
      expect(guideList.parse(await request("/api/guides"))).toEqual(guides);
      // A second import remains selectable without replacing the draft or Guide.
      await writeFile(guideFile, JSON.stringify({ ...guide, title: "Alternative guide" }));
      await exec(
        "plannotator",
        ["guide", "import", "--guide", guideFile, "--patch", join(root, "review.patch")],
        { cwd: root, env, timeout: 10000 },
      );
      expect(guideList.parse(await request("/api/guides"))).toHaveLength(2);
      expect(await request("/api/draft")).toMatchObject(draft);
      expect(await request(guidePath)).toMatchObject({ reviewed: [true] });
      await stop();
      expect(output).toBe(""); // Stopping the process must not submit feedback.
    }, 60000);
    it("runs the production engine adapter with isolated revisions and JSON feedback", async () => {
      root = await mkdtemp(join(tmpdir(), "paseo-plannotator-engine-"));
      await exec("git", ["init", "--quiet"], { cwd: root });
      await exec("git", ["remote", "add", "origin", "https://example.com/team/review.git"], {
        cwd: root,
      });
      const patch =
        "diff --git a/one.txt b/one.txt\n--- a/one.txt\n+++ b/one.txt\n@@ -1 +1 @@\n-before\n+after\n";
      const store = createStore(join(root, "storage"));
      const patchPath = await store.patch("review", "revision", patch);
      const saved = revisionSchema.parse({
        id: "revision",
        createdAt: new Date().toISOString(),
        selection: { mode: "task" },
        resolved: null,
        patchHash: "hash",
        patchPath,
        files: manifest(patch),
        draft: { codeAnnotations: [], viewedFiles: ["one.txt"], ts: Date.now() },
        guides: [],
      });
      const engine = createEngine(process.env);
      const first = await engine.open({
        cwd: root,
        revision: saved,
        directory: store.directory("review", "revision"),
      });
      try {
        expect((await first.read()).draft?.viewedFiles).toEqual(["one.txt"]);
        const document = {
          title: "Adapter import",
          intent: "Inspect behavior",
          sections: [
            {
              title: "Behavior",
              overview: "Review carefully",
              diffs: [{ file: "one.txt", summary: "Changed value" }],
            },
          ],
        };
        const id = await first.importGuide(document);
        expect((await first.read()).guides).toMatchObject([{ id, document }]);
      } finally {
        await first.stop();
      }
      expect(await first.result).toBeNull();
      const reopened = await engine.open({
        cwd: root,
        revision: saved,
        directory: store.directory("review", "revision"),
      });
      const isolatedPatch = await store.patch("other", "same-patch", patch);
      const isolated = await engine.open({
        cwd: root,
        revision: { ...saved, id: "same-patch", patchPath: isolatedPatch, draft: null },
        directory: store.directory("other", "same-patch"),
      });
      try {
        expect((await reopened.read()).guides).toHaveLength(1);
        expect(await isolated.read()).toEqual({ draft: null, guides: [] });
        const response = await fetch(new URL("/api/feedback", reopened.url), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            approved: false,
            feedback: "Production adapter feedback",
            annotations: [],
          }),
        });
        expect(response.status).toBe(200);
        expect(await reopened.result).toMatchObject({
          decision: "annotated",
          message: expect.stringContaining("Production adapter feedback"),
        });
        expect(await isolated.read()).toEqual({ draft: null, guides: [] });
        const ownedSessions = await exec("plannotator", ["sessions", "--json"], {
          env: {
            ...process.env,
            PLANNOTATOR_DATA_DIR: join(store.directory("other", "same-patch"), "plannotator"),
          },
        });
        const owned = sessionList
          .parse(JSON.parse(ownedSessions.stdout))
          .find((item) => new URL(item.url).href === isolated.url);
        if (!owned) throw new Error("Owned test session was not registered");
        process.kill(owned.pid, "SIGKILL");
        await expect(isolated.result).rejects.toThrow("Plannotator exited SIGKILL");
      } finally {
        await reopened.stop();
        await isolated.stop();
      }
    }, 60000);
  },
);
