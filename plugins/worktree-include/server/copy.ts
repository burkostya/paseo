// Derived from cprecioso/paseo-worktreeinclude (MIT); see ./LICENSE in the plugin root.
// Copyright (c) 2026 Carlos Precioso.
import { constants } from "node:fs";
import { copyFile, lstat, mkdir, readFile, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { VcsBinding } from "@getpaseo/plugin";
import type { VcsHostApi } from "@getpaseo/plugin/server/vcs";

const INCLUDE_FILE = ".worktreeinclude";
export type CopyResult =
  | { kind: "no-include-file" }
  | { kind: "copied"; copied: string[]; skipped: string[] };
interface CopyOptions {
  source: VcsBinding;
  target: VcsBinding;
  vcs: Pick<VcsHostApi, "listLocalFiles">;
  signal: AbortSignal;
}

function filePath(root: string, file: string): string {
  const target = resolve(root, file);
  const within = relative(root, target);
  const parts = file.split(/[\\/]/);
  if (
    isAbsolute(file) ||
    !within ||
    isAbsolute(within) ||
    within === ".." ||
    within.startsWith(`..${sep}`) ||
    parts.some((part) => part === ".git" || part === ".jj" || part === "..") ||
    file.includes("\0")
  )
    throw new Error(`Invalid local file path: ${file}`);
  return target;
}

async function ensureParents(root: string, file: string): Promise<void> {
  const parts = relative(root, file).split(sep);
  let current = root;
  for (const part of parts.slice(0, -1)) {
    current = join(current, part);
    try {
      await mkdir(current);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    }
    const entry = await lstat(current);
    if (!entry.isDirectory() || entry.isSymbolicLink())
      throw new Error(`Local file destination is not a directory: ${current}`);
  }
}

export async function copyWorktreeIncludes(options: CopyOptions): Promise<CopyResult> {
  let patterns: string;
  try {
    patterns = await readFile(join(options.source.root, INCLUDE_FILE), "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return { kind: "no-include-file" };
    throw error;
  }
  options.signal.throwIfAborted();
  const paths = await options.vcs.listLocalFiles(options.source, {
    kind: "ignored",
    patterns: patterns.split(/\r?\n/),
  });
  if (paths.length === 0) return { kind: "copied", copied: [], skipped: [] };
  options.signal.throwIfAborted();
  const tracked = await options.vcs.listLocalFiles(options.target, { kind: "tracked" });
  const destination = await lstat(options.target.root);
  if (!destination.isDirectory() || destination.isSymbolicLink())
    throw new Error("Invalid working copy destination");
  const trackedPaths = new Set(tracked);
  const copied: string[] = [];
  const skipped: string[] = [];
  for (const file of new Set(paths)) {
    options.signal.throwIfAborted();
    const source = filePath(options.source.root, file);
    const target = filePath(options.target.root, file);
    if (trackedPaths.has(file)) {
      skipped.push(file);
      continue;
    }
    if (!(await stat(source)).isFile())
      throw new Error(`Included path is not a regular file: ${source}`);
    await ensureParents(options.target.root, target);
    try {
      await copyFile(source, target, constants.COPYFILE_FICLONE | constants.COPYFILE_EXCL);
      copied.push(file);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      skipped.push(file);
    }
  }
  return { kind: "copied", copied, skipped };
}
