import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readdir, rmdir, unlink } from "node:fs/promises";
import path from "node:path";
import { markerName, markerSchema, readCopyMarker } from "./copy-marker.js";
import { recovery } from "./recovery.js";
import { VcsError, type VcsProviderRegistration } from "@getpaseo/plugin/server/vcs";
import { digest, filename, metadata, readHistory, readState, findCheckpoint } from "./store.js";

export const workingCopies: NonNullable<VcsProviderRegistration["workingCopies"]> = {
  recovery,
  async create(binding, input, { signal }) {
    const source = await readHistory(binding.root, signal);
    const checkpoint = findCheckpoint(source, input.revision);
    const history = {
      ...source,
      checkpoints: source.checkpoints.slice(source.checkpoints.indexOf(checkpoint)),
    };
    const root = path.resolve(input.root);
    const marker = {
      version: 1 as const,
      data: {
        repositoryId: binding.repositoryId,
        token: randomUUID(),
        initialVersion: digest([history, checkpoint.text]),
      },
    };
    // Exclusive mkdir keeps an existing directory (including an empty one) out of cleanup.
    await mkdir(root);
    const written: string[] = [];
    let metadataCreated = false;
    try {
      await mkdir(path.join(root, metadata));
      metadataCreated = true;
      const files: [string, string][] = [
        [path.join(metadata, "history.json"), JSON.stringify(history)],
        [path.join(metadata, markerName), JSON.stringify(marker)],
      ];
      if (checkpoint.text !== null) files.push([filename, checkpoint.text]);
      for (const [name, text] of files) {
        const file = path.join(root, name);
        // Track partial writes too, so cancellation can remove files we created.
        const handle = await open(file, "wx");
        written.push(file);
        try {
          await handle.writeFile(text, { signal });
        } finally {
          await handle.close();
        }
      }
      if (signal.aborted)
        throw new VcsError({ code: "cancelled", message: "Copy operation cancelled" });
      return {
        binding: { ...binding, root, cwd: root, workingCopyId: root },
        owned: true,
        source: binding,
        data: marker,
      };
    } catch (error) {
      for (const file of written.toReversed()) await unlink(file);
      if (metadataCreated) await rmdir(path.join(root, metadata));
      await rmdir(root);
      throw error;
    }
  },
  async rollback(binding, record, { signal }) {
    const root = record.binding.root;
    const expected = markerSchema.parse(record.data);
    const actual = await readCopyMarker(root);
    const state = await readState(root, signal);
    if (
      !record.owned ||
      root === binding.root ||
      expected.data.repositoryId !== binding.repositoryId ||
      JSON.stringify(actual) !== JSON.stringify(expected) ||
      state.version !== expected.data.initialVersion
    ) {
      throw new VcsError({
        code: "outdated",
        message: "Copy changed; inspect it before removing it",
      });
    }
    const entries = await readdir(root);
    const metaEntries = await readdir(path.join(root, metadata));
    if (
      entries.some((name) => name !== filename && name !== metadata) ||
      metaEntries.some((name) => name !== "history.json" && name !== markerName)
    ) {
      throw new VcsError({
        code: "conflict",
        message: "Copy contains additional files; keep it for manual cleanup",
      });
    }
    for (const file of [
      root,
      path.join(root, metadata),
      ...metaEntries.map((name) => path.join(root, metadata, name)),
      ...entries.filter((name) => name === filename).map((name) => path.join(root, name)),
    ]) {
      if ((await lstat(file)).isSymbolicLink())
        throw new VcsError({
          code: "conflict",
          message: "Copy contains symbolic links; inspect it before removing it",
        });
    }
    if (signal.aborted)
      throw new VcsError({ code: "cancelled", message: "Copy operation cancelled" });
    if (state.text !== null) await unlink(path.join(root, filename));
    for (const name of metaEntries) await unlink(path.join(root, metadata, name));
    await rmdir(path.join(root, metadata));
    await rmdir(root);
  },
};
