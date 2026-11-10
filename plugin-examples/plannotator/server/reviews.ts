import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import {
  guideDocument,
  type ReviewState,
  type Revision,
  type Target,
  type Operation,
  type SourceSelection,
  type GuideDocument,
  type Guide,
  type Delivery,
} from "../shared/review";
import type { ReviewPorts, EngineSession } from "./ports";
import { hash } from "./source";

export function coverage(document: GuideDocument, revision: Revision): string[] {
  const files = new Set(revision.files.map((file) => file.path));
  const covered = new Set<string>();
  for (const section of document.sections) {
    const seen = new Set<string>();
    for (const diff of section.diffs) {
      if (!files.has(diff.file))
        throw new Error(`Guide names a file outside this snapshot: ${diff.file}`);
      if (seen.has(diff.file)) throw new Error(`Guide repeats a file in one section: ${diff.file}`);
      seen.add(diff.file);
      covered.add(diff.file);
    }
  }
  return [...files].filter((file) => !covered.has(file));
}
export function carryViewed(previous: Revision, next: Revision) {
  const viewed = new Set(previous.draft?.viewedFiles ?? []);
  const fingerprints = new Map(previous.files.map((file) => [file.path, file.fingerprint]));
  return next.files
    .filter((file) => viewed.has(file.path) && fingerprints.get(file.path) === file.fingerprint)
    .map((file) => file.path);
}
const guideResponse = z.object({
  requestId: z.string(),
  revisionId: z.string(),
  patchHash: z.string(),
  guide: guideDocument,
  outsideSections: z.array(z.string()),
});
interface Running {
  revisionId: string;
  session: EngineSession;
}
export function createReviews(ports: ReviewPorts) {
  const { source, engine, store, conversation } = ports;
  const records = new Map<string, ReviewState>();
  const sessions = new Map<string, Running>();
  const tasks = new Map<string, Promise<unknown>>();
  let stopped = false;
  function serial<T>(agentId: string, task: () => Promise<T>): Promise<T> {
    const next = (tasks.get(agentId) ?? Promise.resolve()).then(task);
    tasks.set(
      agentId,
      next.catch(() => {}),
    );
    return next;
  }
  async function load(target: Target) {
    let state = records.get(target.agentId) ?? null;
    if (!state) {
      state = await store.find(target.agentId);
      if (state) {
        for (const item of state.deliveries) {
          if (item.status === "sending") {
            item.status = "unknown";
            item.error =
              "Delivery outcome unknown after restart. Check the original agent before retrying.";
          }
        }
        state.status = "paused";
        state.url = null;
        state.liveRevisionId = null;
        records.set(target.agentId, state);
        await store.save(state);
      }
    }
    if (state && state.workspaceId !== target.workspaceId)
      throw new Error("Review belongs to another workspace");
    return state;
  }
  async function expected(input: Operation) {
    const state = await load(input);
    if (!state || state.id !== input.reviewId || state.revisionId !== input.revisionId)
      throw new Error("Review revision changed. Refresh the panel.");
    return state;
  }
  function revisionOf(state: ReviewState, id = state.revisionId) {
    const revision = state.revisions.find((item) => item.id === id);
    if (!revision) throw new Error("Review revision is unavailable");
    return revision;
  }
  async function capture(state: ReviewState) {
    const running = sessions.get(state.agentId);
    if (!running) return;
    const revision = revisionOf(state, running.revisionId);
    const engineState = await running.session.read();
    revision.draft = engineState.draft;
    for (const saved of engineState.guides) {
      let item = revision.guides.find((guide) => guide.engineId === saved.id);
      if (!item) {
        item = {
          id: randomUUID(),
          source: "plannotator",
          requestId: null,
          status: "ready",
          engineId: saved.id,
          document: saved.document,
          reviewed: saved.reviewed,
          uncovered: [],
          error: null,
        };
        revision.guides.push(item);
      }
      item.document = saved.document;
      item.reviewed = saved.reviewed;
      item.uncovered = coverage(saved.document, revision);
    }
  }
  async function pause(state: ReviewState) {
    const running = sessions.get(state.agentId);
    if (!running) return;
    try {
      await capture(state);
    } catch (error) {
      state.error = `Review paused without a fresh state capture: ${String(error)}`;
    } finally {
      sessions.delete(state.agentId);
      await running.session.stop();
      state.url = null;
      state.liveRevisionId = null;
    }
  }
  async function deliver(state: ReviewState, item: Delivery) {
    try {
      await conversation.inspect(state);
    } catch (error) {
      item.status = "failed";
      item.error = String(error);
      state.status = "paused";
      await store.save(state);
      return;
    }
    item.status = "sending";
    item.error = null;
    state.status = "sending";
    await store.save(state);
    try {
      await conversation.send(state, item.text, item.id);
      item.status = "sent";
      state.status = "sent";
    } catch (error) {
      item.status = "unknown";
      item.error = `Delivery outcome unknown. Check the original agent before retrying. ${String(error)}`;
      state.status = "paused";
    }
    await store.save(state);
  }
  async function launch(state: ReviewState, viewRevisionId = state.revisionId) {
    const existing = sessions.get(state.agentId);
    if (existing?.revisionId === viewRevisionId) return state;
    if (existing) await pause(state);
    if (stopped) throw new Error("Plugin is stopping");
    const revision = revisionOf(state, viewRevisionId);
    const agent = await conversation.inspect(state);
    state.cwd = agent.cwd;
    state.status = "starting";
    state.error = null;
    await store.save(state);
    try {
      const session = await engine.open({
        cwd: agent.cwd,
        revision,
        directory: store.directory(state.id, revision.id),
      });
      const running = { session, revisionId: revision.id };
      sessions.set(state.agentId, running);
      state.url = session.url;
      state.liveRevisionId = revision.id;
      state.status = "reviewing";
      await store.save(state);
      void session.result
        .then(
          (result) =>
            serial(state.agentId, async () => {
              if (stopped || sessions.get(state.agentId) !== running) return;
              sessions.delete(state.agentId);
              state.url = null;
              state.liveRevisionId = null;
              if (!result || result.decision === "dismissed") {
                state.status = "paused";
                await store.save(state);
                return;
              }
              const resolved = revision.resolved;
              const text = [
                `Plannotator review · ${resolved?.description ?? "Legacy uncommitted changes"}`,
                `Revision: ${revision.id}`,
                `Patch SHA-256: ${revision.patchHash ?? "unknown"}`,
                `Base: ${resolved?.baseRevision ?? "unknown"}`,
                `Merge-base: ${resolved?.mergeBaseRevision ?? "not applicable"}`,
                `HEAD: ${resolved?.headRevision ?? "unknown"}`,
                "",
                result.message,
              ].join("\n");
              const item: Delivery = {
                id: randomUUID(),
                revisionId: revision.id,
                agentId: state.agentId,
                text,
                status: "pending",
                error: null,
              };
              state.deliveries.push(item);
              await store.save(state);
              await deliver(state, item);
            }),
          (error) =>
            serial(state.agentId, async () => {
              if (stopped || sessions.get(state.agentId) !== running) return;
              sessions.delete(state.agentId);
              state.url = null;
              state.liveRevisionId = null;
              state.status = "failed";
              state.error = String(error);
              await store.save(state);
            }),
        )
        .catch((error) => {
          state.status = "failed";
          state.error = `Could not persist review result: ${String(error)}`;
        });
      return state;
    } catch (error) {
      state.status = "failed";
      state.error = String(error);
      state.url = null;
      await store.save(state);
      throw error;
    }
  }
  async function snapshot(state: ReviewState, selection: SourceSelection) {
    const saved = await source.snapshot(state, selection);
    const patchHash = hash(saved.patch);
    const previous = state.revisions.find((item) => item.id === state.revisionId);
    if (previous?.patchHash === patchHash) return false;
    const id = randomUUID();
    const revision: Revision = {
      id,
      createdAt: new Date().toISOString(),
      selection,
      resolved: saved.resolved,
      patchHash,
      patchPath: await store.patch(state.id, id, saved.patch),
      files: saved.files,
      draft: null,
      guides: [],
    };
    if (previous) {
      const viewedFiles = carryViewed(previous, revision);
      if (viewedFiles.length) revision.draft = { codeAnnotations: [], viewedFiles, ts: Date.now() };
      for (const guide of previous.guides)
        if (guide.status === "pending") guide.status = "cancelled";
    }
    state.revisions.push(revision);
    state.revisionId = id;
    state.error = null;
    state.status = "paused";
    await store.save(state);
    return true;
  }
  async function pendingGuides(state: ReviewState) {
    const revision = revisionOf(state);
    for (const guide of revision.guides.filter((item) => item.status === "pending")) {
      const path = join(
        store.directory(state.id, revision.id),
        "requests",
        guide.requestId!,
        "guide.json",
      );
      try {
        const raw = await store.readGuide(path);
        if (raw === null) continue;
        const response = guideResponse.parse(raw);
        if (
          response.requestId !== guide.requestId ||
          response.revisionId !== revision.id ||
          response.patchHash !== revision.patchHash
        )
          throw new Error("Guide belongs to another request or revision");
        const uncovered = coverage(response.guide, revision);
        if (
          new Set(response.outsideSections).size !== response.outsideSections.length ||
          JSON.stringify([...response.outsideSections].sort()) !==
            JSON.stringify([...uncovered].sort())
        )
          throw new Error("Guide must list every uncovered file in outsideSections");
        await launch(state);
        const running = sessions.get(state.agentId)!;
        const engineId = await running.session.importGuide(response.guide);
        Object.assign(guide, {
          status: "ready",
          engineId,
          document: response.guide,
          uncovered,
          reviewed: response.guide.sections.map(() => false),
        });
      } catch (error) {
        guide.status = "failed";
        guide.error = String(error);
      }
    }
  }
  let polling = false;
  const timer = setInterval(() => {
    if (polling || stopped) return;
    polling = true;
    void Promise.all(
      [...records.values()].map((state) =>
        serial(state.agentId, async () => {
          if (stopped) return;
          const before = JSON.stringify(state);
          try {
            await pendingGuides(state);
            await capture(state);
          } catch (error) {
            state.error = `Could not save live review state: ${String(error)}`;
          }
          if (before !== JSON.stringify(state)) await store.save(state);
        }),
      ),
    )
      .catch((error) => {
        for (const state of records.values())
          state.error = `Review state could not be persisted: ${String(error)}`;
      })
      .finally(() => {
        polling = false;
      });
  }, 1000);
  timer.unref();
  return {
    prepare: source.prepare,
    get: (target: Target) => serial(target.agentId, () => load(target)),
    start: (target: Target, selection: SourceSelection) =>
      serial(target.agentId, async () => {
        const old = await load(target);
        if (old) return launch(old);
        const ready = await source.prepare(target, selection);
        if (ready.error) throw new Error(ready.error);
        const state: ReviewState = {
          version: 2,
          id: randomUUID(),
          ...target,
          workspaceName: ready.workspaceName,
          agentName: ready.agentName,
          cwd: ready.cwd,
          revisionId: "",
          status: "paused",
          liveRevisionId: null,
          url: null,
          error: null,
          revisions: [],
          deliveries: [],
        };
        await snapshot(state, selection);
        records.set(target.agentId, state);
        return launch(state);
      }),
    open: (input: Operation, viewRevisionId?: string) =>
      serial(input.agentId, async () => launch(await expected(input), viewRevisionId)),
    update: (input: Operation, selection: SourceSelection) =>
      serial(input.agentId, async () => {
        const state = await expected(input);
        await pause(state);
        state.status = "paused";
        await store.save(state);
        try {
          await snapshot(state, selection);
        } catch (error) {
          state.error = String(error);
          await store.save(state);
          throw error;
        }
        return launch(state);
      }),
    cancel: (input: Operation) =>
      serial(input.agentId, async () => {
        const state = await expected(input);
        await pause(state);
        state.status = "cancelled";
        for (const guide of revisionOf(state).guides)
          if (guide.status === "pending") guide.status = "cancelled";
        await store.save(state);
        return state;
      }),
    retry: (input: Operation, deliveryId: string) =>
      serial(input.agentId, async () => {
        const state = await expected(input);
        const item = state.deliveries.find((candidate) => candidate.id === deliveryId);
        if (!item || !["failed", "unknown", "pending"].includes(item.status))
          throw new Error("Delivery cannot be retried");
        await deliver(state, item);
        return state;
      }),
    requestGuide: (input: Operation) =>
      serial(input.agentId, async () => {
        const state = await expected(input);
        const agent = await conversation.inspect(state);
        if (agent.busy)
          throw new Error(
            "The original agent is busy. Request the Guide after its current turn finishes.",
          );
        const revision = revisionOf(state);
        if (!revision.patchPath || !revision.patchHash)
          throw new Error("Update the legacy review before requesting a Guide");
        if (revision.guides.some((item) => item.status === "pending"))
          throw new Error("A Guide request is already pending");
        const requestId = randomUUID();
        const example = {
          requestId,
          revisionId: revision.id,
          patchHash: revision.patchHash,
          guide: {
            title: "Review guide",
            intent: "Explain how to read the changes",
            sections: [
              {
                title: "Behavior",
                overview: "Why to read these changes first",
                diffs: [{ file: revision.files[0].path, summary: "What to check" }],
              },
            ],
          },
          outsideSections: revision.files.slice(1).map((file) => file.path),
        };
        const files = await store.request(
          state.id,
          revision.id,
          requestId,
          JSON.stringify(
            {
              requestId,
              revisionId: revision.id,
              patchHash: revision.patchHash,
              patchPath: revision.patchPath,
              requestPath: join(
                store.directory(state.id, revision.id),
                "requests",
                requestId,
                "request.json",
              ),
              outputPath: join(
                store.directory(state.id, revision.id),
                "requests",
                requestId,
                "guide.json",
              ),
              comparison: revision.resolved,
              manifest: revision.files,
              outputExample: example,
              outputSchema: z.toJSONSchema(guideResponse),
            },
            null,
            2,
          ),
        );
        const guide: Guide = {
          id: randomUUID(),
          source: "paseo-agent",
          requestId,
          status: "pending",
          engineId: null,
          document: null,
          reviewed: [],
          uncovered: [],
          error: null,
        };
        revision.guides.push(guide);
        await store.save(state);
        const text = `Prepare a Guided Review for the exact saved patch described in ${files.input}. Read that JSON and its patchPath. Do not change task code. Group changes by meaning, explain the reading order and what to check. This Guide is not approval of the changes. Produce JSON in the outputExample shape; preserve requestId, revisionId and patchHash exactly. Use only manifest paths, list each file in a section or outsideSections, and do not repeat a file within a section. title/intent/title/overview/file/summary must be strings; sections and diffs are arrays. Write the complete result to ${files.output}.tmp, then atomically rename it to ${files.output}. Do not put the result only in chat.`;
        try {
          await conversation.send(state, text, requestId);
        } catch (error) {
          guide.status = "failed";
          guide.error = `Guide request delivery failed or is unknown; no automatic retry. ${String(error)}`;
        }
        await store.save(state);
        return state;
      }),
    cancelGuide: (input: Operation, requestId: string) =>
      serial(input.agentId, async () => {
        const state = await expected(input);
        const guide = revisionOf(state).guides.find((item) => item.requestId === requestId);
        if (!guide || guide.status !== "pending")
          throw new Error("Guide request is no longer pending");
        guide.status = "cancelled";
        await store.save(state);
        return state;
      }),
    async stop() {
      stopped = true;
      clearInterval(timer);
      await Promise.all(
        [...records.values()].map((state) =>
          serial(state.agentId, async () => {
            try {
              await pause(state);
            } catch (error) {
              state.error = `Review paused without a fresh state capture: ${String(error)}`;
            }
            state.status = "paused";
            state.url = null;
            state.liveRevisionId = null;
            await store.save(state);
          }),
        ),
      );
    },
  };
}
