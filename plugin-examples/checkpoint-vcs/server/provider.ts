import { stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { VcsError, type VcsProviderRegistration } from "@getpaseo/plugin/server/vcs";
import { workingCopies } from "./working-copies.js";
import { readCopyMarker } from "./copy-marker.js";
import { patch } from "./patch.js";
import {
  filename,
  metadata,
  maxCheckpoints,
  missing,
  readState,
  readHistory,
  revision,
  findCheckpoint,
  saveCheckpoint,
  type CapturedState,
} from "./store.js";

const versionSchema = z.object({ version: z.literal(1), data: z.object({ snapshot: z.string() }) });
const cursorSchema = z.object({ version: z.string(), offset: z.number().int().nonnegative() });
const inputSchema = z.object({ description: z.string().trim().min(1).max(200) }).strict();

export function createCheckpointProvider(): VcsProviderRegistration {
  const snapshots = new Map<string, CapturedState>();
  function remember(state: CapturedState) {
    snapshots.set(JSON.stringify([state.root, state.version]), state);
    if (snapshots.size > 8) snapshots.delete(snapshots.keys().next().value!);
    return state;
  }
  function frozen(root: string, version: string) {
    const state = snapshots.get(JSON.stringify([root, version]));
    if (!state)
      throw new VcsError({ code: "outdated", message: "Snapshot expired; refresh Changes" });
    return state;
  }
  return {
    id: "checkpoint-vcs",
    label: "Checkpoints (example)",
    detectionPriority: 100,
    workingCopies,
    async detect(cwd) {
      let root = path.resolve(cwd);
      while (true) {
        try {
          if ((await stat(path.join(root, metadata))).isDirectory())
            return {
              status: "available",
              binding: {
                providerId: "checkpoint-vcs",
                repositoryId: (await readCopyMarker(root))?.data.repositoryId ?? root,
                workingCopyId: root,
                root,
                cwd,
              },
            };
        } catch (error) {
          if (!missing(error)) throw error;
        }
        const parent = path.dirname(root);
        if (parent === root) return { status: "absent" };
        root = parent;
      }
    },
    async snapshot(binding, { signal }) {
      const state = remember(await readState(binding.root, signal));
      const head = state.history.checkpoints[0];
      const changed = (head?.text ?? null) !== state.text;
      const full = state.history.checkpoints.length >= maxCheckpoints;
      let status = head?.text == null ? "added" : "modified";
      if (state.text === null) status = "deleted";
      let reason = changed ? undefined : "No changes to checkpoint";
      if (full) reason = "Example limit: 32 checkpoints";
      return {
        binding,
        version: state.version,
        current: head ? revision(head) : null,
        workingComparison: {
          kind: "working-copy",
          data: { version: 1, data: { snapshot: state.version } },
        },
        files: changed
          ? [
              {
                path: filename,
                status,
                conflict: false,
              },
            ]
          : [],
        refs: [],
        capabilities: ["diff", "history", "actions"],
        state: "ready",
        actions: [
          {
            id: "checkpoint.create",
            enabled: changed && !full,
            reason,
          },
        ],
      };
    },
    async observation(binding, { signal }) {
      const state = await readState(binding.root, signal);
      return {
        fingerprint: state.version,
        roots: [{ path: binding.root, kind: "files", scope: "working-copy" }],
      };
    },
    async history(binding, input, { signal }) {
      const cursor = input.cursor ? cursorSchema.parse(JSON.parse(input.cursor)) : null;
      if (cursor && input.version && cursor.version !== input.version)
        throw new VcsError({
          code: "outdated",
          message: "History cursor belongs to another snapshot",
        });
      const version = input.version ?? cursor?.version;
      const state = version
        ? frozen(binding.root, version)
        : remember(await readState(binding.root, signal));
      const offset = cursor?.offset ?? 0;
      const end = offset + input.limit;
      return {
        revisions: state.history.checkpoints.slice(offset, end).map(revision),
        cursor:
          end < state.history.checkpoints.length
            ? JSON.stringify({ version: state.version, offset: end })
            : undefined,
      };
    },
    async diff(binding, comparison, { signal }) {
      if (comparison.kind === "working-copy") {
        const version = versionSchema.parse(comparison.data).data.snapshot;
        const state = frozen(binding.root, version);
        return patch(state.history.checkpoints[0]?.text ?? null, state.text);
      }
      const history = await readHistory(binding.root, signal);
      if (comparison.kind === "range")
        return patch(
          findCheckpoint(history, comparison.from).text,
          findCheckpoint(history, comparison.to).text,
        );
      const checkpoint = findCheckpoint(history, comparison.revision);
      const parent = checkpoint.parents[0];
      return patch(parent ? findCheckpoint(history, parent).text : null, checkpoint.text);
    },
    async execute(binding, action, input, { snapshot, signal }) {
      if (action !== "checkpoint.create")
        throw new VcsError({ code: "provider", message: "Unknown checkpoint action" });
      const { description } = inputSchema.parse(input);
      const state = await readState(binding.root, signal);
      if (state.version !== snapshot.version)
        throw new VcsError({
          code: "outdated",
          message: "File changed; review the checkpoint again",
        });
      return { revision: await saveCheckpoint(state, description, signal) };
    },
  };
}
