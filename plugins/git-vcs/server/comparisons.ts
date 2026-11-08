import { tmpdir } from "node:os";
import { execCommand } from "@getpaseo/plugin/server";
import { lstat, mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { VcsError, type VcsContext } from "@getpaseo/plugin/server/vcs";
import type { VcsBinding } from "@getpaseo/plugin";
import { z } from "zod";
export type GitCommand = (cwd: string, args: string[], context: VcsContext) => Promise<string>;
export const comparisonData = z.object({
  version: z.literal(1),
  data: z.object({ version: z.string(), mode: z.enum(["all", "staged", "unstaged"]) }),
});
interface Saved {
  head: string;
  all: string;
  staged: string;
  unstaged: string;
}
// Frozen patches keep forms and their file choices on one version. Bound retained bytes across copies.
export function createGitComparisons() {
  const entries = new Map<string, Saved>();
  let bytes = 0;
  const size = (value: Saved) => Buffer.byteLength(value.all + value.staged + value.unstaged);
  return {
    remove(binding: VcsBinding, version: string) {
      const key = JSON.stringify([binding.repositoryId, binding.workingCopyId, version]);
      const value = entries.get(key);
      if (value) {
        bytes -= size(value);
        entries.delete(key);
      }
    },
    save(binding: VcsBinding, version: string, value: Saved) {
      const key = JSON.stringify([binding.repositoryId, binding.workingCopyId, version]);
      const old = entries.get(key);
      if (old) bytes -= size(old);
      entries.delete(key);
      entries.set(key, value);
      bytes += size(value);
      while (entries.size > 1 && (entries.size > 32 || bytes > 64 * 1024 * 1024)) {
        const oldest = entries.keys().next().value!;
        bytes -= size(entries.get(oldest)!);
        entries.delete(oldest);
      }
    },
    get(binding: VcsBinding, version: string) {
      const value = entries.get(
        JSON.stringify([binding.repositoryId, binding.workingCopyId, version]),
      );
      if (!value)
        throw new VcsError({
          code: "outdated",
          message: "Comparison expired. Refresh the workspace.",
        });
      return value;
    },
  };
}
export async function untrackedPatch(
  git: GitCommand,
  binding: VcsBinding,
  files: string[],
  context: VcsContext,
) {
  let patch = "";
  for (const file of files) {
    try {
      const info = await lstat(path.join(binding.root, file));
      if (info.isDirectory()) continue;
      patch += await git(
        binding.root,
        [
          "diff",
          "--no-index",
          "--no-ext-diff",
          "--no-textconv",
          "--binary",
          "--",
          "/dev/null",
          file,
        ],
        context,
      );
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        error.code !== 1 ||
        !("stdout" in error) ||
        typeof error.stdout !== "string"
      )
        throw error;
      patch += error.stdout;
    }
  }
  return patch;
}

/** Reconstruct a captured view in a private index/object store; never reread the working tree. */
export async function comparisonPatch(
  git: GitCommand,
  binding: VcsBinding,
  saved: Saved,
  input: import("zod").z.infer<typeof import("../shared/comparison.js").gitComparisonData>["data"],
  context: VcsContext,
): Promise<string> {
  const baseMode = input.mode === "combined" || input.mode === "committed";
  if (baseMode && !input.base) throw new Error("Select a comparison base");
  if (baseMode && !saved.head) throw new Error("Create the first commit before comparing a base");
  const mergeBase = baseMode
    ? (await git(binding.root, ["merge-base", "--all", saved.head, input.base!], context))
        .trim()
        .split("\n")
    : [];
  if (baseMode && mergeBase.length !== 1)
    throw new Error("Select a base with one unambiguous merge base");
  const flags = [
    "--no-ext-diff",
    "--no-textconv",
    "--binary",
    ...(input.ignoreWhitespace ? ["--ignore-all-space"] : []),
  ];
  if (input.mode === "committed")
    return git(binding.root, ["diff", ...flags, mergeBase[0]!, saved.head, "--"], context);
  if (!baseMode && !input.ignoreWhitespace)
    return saved[input.mode as "all" | "staged" | "unstaged"];
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-git-comparison-"));
  try {
    const objects = path.join(directory, "objects");
    await mkdir(objects);
    const source = (
      await git(
        binding.root,
        ["rev-parse", "--path-format=absolute", "--git-path", "objects"],
        context,
      )
    ).trim();
    const env = {
      ...process.env,
      GIT_INDEX_FILE: path.join(directory, "index"),
      GIT_OBJECT_DIRECTORY: objects,
      GIT_ALTERNATE_OBJECT_DIRECTORIES: [source, process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES]
        .filter(Boolean)
        .join(path.delimiter),
      GIT_OPTIONAL_LOCKS: "0",
      GIT_TERMINAL_PROMPT: "0",
      GIT_LITERAL_PATHSPECS: "1",
    };
    const run = async (args: string[]) =>
      (
        await execCommand("git", ["--no-pager", ...args], {
          cwd: binding.root,
          env,
          signal: context.signal,
          timeout: 30000,
          maxBuffer: 20 * 1024 * 1024,
        })
      ).stdout;
    await run(saved.head ? ["read-tree", saved.head] : ["read-tree", "--empty"]);
    const initial = (await run(["write-tree"])).trim();
    const apply = async (patch: string) => {
      if (!patch) return;
      const file = path.join(directory, "view.patch");
      await writeFile(file, patch);
      await run(["apply", "--cached", "--binary", "--whitespace=nowarn", "--", file]);
    };
    let from = baseMode ? mergeBase[0]! : initial;
    if (input.mode === "unstaged") {
      await apply(saved.staged);
      from = (await run(["write-tree"])).trim();
      await run(saved.head ? ["read-tree", saved.head] : ["read-tree", "--empty"]);
    }
    await apply(input.mode === "staged" ? saved.staged : saved.all);
    const to = (await run(["write-tree"])).trim();
    return await run(["diff", ...flags, from, to, "--"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
