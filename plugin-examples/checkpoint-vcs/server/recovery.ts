import { lstat, mkdir, open, readdir, rmdir, unlink } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { VcsWorkingCopyRecord } from "@getpaseo/plugin";
import { VcsError, type VcsWorkingCopyRecovery } from "@getpaseo/plugin/server/vcs";
import { markerName, markerSchema, readCopyMarker } from "./copy-marker.js";
import {
  digest,
  filename,
  metadata,
  missing,
  historySchema,
  textSchema,
  readState,
} from "./store.js";

const relativeDirectory = z
  .string()
  .min(1)
  .refine(
    (value) =>
      !path.isAbsolute(value) &&
      value.split(/[\\/]/).every((part) => part !== ".." && part !== "." && part !== ""),
  );
const savedSchema = z.object({
  version: z.literal(1),
  data: z.object({
    root: z.string(),
    marker: markerSchema,
    history: historySchema,
    text: textSchema,
    directories: z.array(relativeDirectory).max(128),
  }),
});
function fail(message: string): never {
  throw new VcsError({ code: "outdated", message });
}
function cancelled(signal: AbortSignal) {
  if (signal.aborted) throw new VcsError({ code: "cancelled", message: "Recovery cancelled" });
}
async function exists(root: string) {
  try {
    await lstat(root);
    return true;
  } catch (error) {
    if (missing(error)) return false;
    throw error;
  }
}
async function validate(record: VcsWorkingCopyRecord) {
  const marker = markerSchema.parse(record.data);
  if (
    !record.owned ||
    record.binding.root === record.binding.repositoryId ||
    marker.data.repositoryId !== record.binding.repositoryId ||
    (await lstat(record.binding.root)).isSymbolicLink() ||
    (await lstat(path.join(record.binding.root, metadata))).isSymbolicLink() ||
    digest(await readCopyMarker(record.binding.root)) !== digest(marker)
  )
    fail("Working copy identity changed; directory retained");
  for (const name of ["history.json", markerName]) {
    if (!(await lstat(path.join(record.binding.root, metadata, name))).isFile())
      fail("Working copy metadata changed; directory retained");
  }
  return marker;
}
async function directories(root: string, signal: AbortSignal) {
  const result: string[] = [];
  async function visit(relative: string) {
    cancelled(signal);
    for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
      const name = path.join(relative, entry.name);
      if (entry.isDirectory()) {
        result.push(name);
        if (result.length > 128) fail("Example limit: 128 directories per working copy");
        await visit(name);
      } else if (
        !entry.isFile() ||
        ![filename, path.join(metadata, "history.json"), path.join(metadata, markerName)].includes(
          name,
        )
      ) {
        throw new VcsError({
          code: "conflict",
          message: `Directory retained: file is not preserved: ${name}`,
        });
      }
    }
  }
  await visit("");
  return result.sort();
}
function saved(record: VcsWorkingCopyRecord) {
  const data = savedSchema.parse(record.recovery).data;
  if (data.root !== record.binding.root || digest(data.marker) !== digest(record.data))
    fail("Recovery belongs to another working copy");
  return data;
}
async function capture(record: VcsWorkingCopyRecord, signal: AbortSignal) {
  const marker = await validate(record);
  const dirs = await directories(record.binding.root, signal);
  const state = await readState(record.binding.root, signal);
  return {
    root: record.binding.root,
    marker,
    history: state.history,
    text: state.text,
    directories: dirs,
  };
}

export const recovery: VcsWorkingCopyRecovery = {
  async inspect(record) {
    if (await exists(record.binding.root)) {
      if (record.state === "restoring")
        fail("Partial restore retained; move the directory aside before retrying");
      await validate(record);
    } else saved(record);
  },
  async prepareRemoval(record, { signal }) {
    return {
      ...record,
      recoveryError: undefined,
      recovery: { version: 1, data: await capture(record, signal) },
    };
  },
  async remove(record, { signal }) {
    const data = saved(record);
    if (digest(await capture(record, signal)) !== digest(data))
      fail("Copy changed after preparation; directory retained");
    cancelled(signal);
    // The host persists the full recovery envelope before requesting deletion.
    // Never recursively remove unknown files, even if an external writer races this check.
    if (data.text !== null) await unlink(path.join(data.root, filename));
    await unlink(path.join(data.root, metadata, "history.json"));
    await unlink(path.join(data.root, metadata, markerName));
    for (const dir of [...data.directories].sort((a, b) => b.length - a.length))
      await rmdir(path.join(data.root, dir));
    await rmdir(data.root);
    return record;
  },
  async restore(record, { signal }) {
    cancelled(signal);
    if (await exists(record.binding.root)) {
      if (record.state === "restoring")
        fail("Partial restore retained; move the directory aside before retrying");
      // Another workspace may already have restored this copy and released its recovery data.
      // Reopening its sibling must retain edits made since then.
      await validate(record);
      return { ...record, recoveryError: undefined };
    }
    const data = saved(record);
    await mkdir(path.dirname(data.root), { recursive: true });
    await mkdir(data.root);
    // A failed restore leaves its partial directory and durable record for inspection.
    for (const dir of [...data.directories].sort((a, b) => a.length - b.length))
      await mkdir(path.join(data.root, dir));
    const files: [string, string][] = [
      [path.join(metadata, "history.json"), JSON.stringify(data.history)],
      [path.join(metadata, markerName), JSON.stringify(data.marker)],
    ];
    if (data.text !== null) files.push([filename, data.text]);
    for (const [name, text] of files) {
      cancelled(signal);
      const handle = await open(path.join(data.root, name), "wx");
      try {
        await handle.writeFile(text, { signal });
      } finally {
        await handle.close();
      }
    }
    return { ...record, recoveryError: undefined };
  },
  async release(record) {
    await validate(record);
    return { ...record, recovery: undefined, recoveryError: undefined };
  },
};
