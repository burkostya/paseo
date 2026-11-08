import { lstat, rm } from "node:fs/promises";
import path from "node:path";
import { VcsError, type VcsContext } from "@getpaseo/plugin/server/vcs";
import type { JsonValue, VcsBinding, VcsSnapshot } from "@getpaseo/plugin";
import { actionInput, actionIds } from "../shared/actions.js";
import type { GitCommand } from "./comparisons.js";
export function gitActions(
  files: VcsSnapshot["files"],
  head: string,
  branch: string | null,
  busy: boolean,
) {
  const conflicts = files.some((file) => file.conflict);
  return actionIds.map((id) => {
    let reason: string | undefined;
    if (
      ["merge", "branch-switch", "branch-create", "pull", "pull-and-push"].includes(id) &&
      files.length
    )
      reason = "Commit or discard working-copy changes first";
    if (["merge", "branch-create", "restore", "branch-delete"].includes(id) && !head)
      reason = "Create the first commit first";
    if (["pull", "pull-and-push"].includes(id) && !branch)
      reason = "Switch to a local branch first";
    if (id === "commit" && !files.length) reason = "No changes to commit";
    if (id === "stage" && !files.some((file) => file.status[1] !== " "))
      reason = "No unstaged files";
    if (id === "unstage" && !files.some((file) => ![" ", "?"].includes(file.status[0]!)))
      reason = "No staged files";
    if (id === "discard" && !files.length) reason = "No changes to discard";
    if (id === "commit" && conflicts) reason = "Resolve conflicts before committing";
    if (busy && !["stage", "unstage", "commit", "fetch", "discard", "restore"].includes(id))
      reason = "Finish the current merge or rebase first";
    return { id, enabled: !reason, reason };
  });
}
export async function executeGitAction(
  git: GitCommand,
  binding: VcsBinding,
  snapshot: VcsSnapshot,
  action: string,
  input: JsonValue,
  context: VcsContext,
) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("Action parameters must be an object");
  const value = actionInput.parse({ ...input, action });
  const run = (args: string[]) => git(binding.root, args, context);
  if (value.action === "fetch") return { output: await run(["fetch", "--", value.remote]) };
  if (value.action === "push")
    return {
      output: await run([
        "push",
        "--",
        value.remote,
        `refs/heads/${value.name}:refs/heads/${value.name}`,
      ]),
    };
  if (value.action === "pull" || value.action === "pull-and-push") {
    const output = await run(["pull", "--ff-only", "--", value.remote, value.name]);
    if (value.action === "pull") return { output };
    return {
      output: output + (await run(["push", "--", value.remote, `HEAD:refs/heads/${value.name}`])),
    };
  }
  if (value.action === "branch-create")
    return { output: await run(["switch", "-c", value.name, value.revision]) };
  if (value.action === "branch-switch") return { output: await run(["switch", "--", value.name]) };
  if (value.action === "branch-delete")
    return { output: await run(["branch", "-d", "--", value.name]) };
  if (value.action === "merge")
    return { output: await run(["merge", "--no-edit", "--", value.revision]) };
  if (value.action === "commit") {
    if (value.all) await run(["add", "--all", "--", "."]);
    return { output: await run(["commit", "-m", value.message]) };
  }
  return executeFileAction(run, binding, snapshot, value);
}
async function executeFileAction(
  run: (args: string[]) => Promise<string>,
  binding: VcsBinding,
  snapshot: VcsSnapshot,
  value: Extract<import("zod").z.infer<typeof actionInput>, { files: string[] }>,
) {
  // Literal pathspecs prevent filenames such as :(glob)* from selecting unrelated files.
  const files = [...new Set(value.files)];
  for (const file of files) {
    const relative = path.relative(binding.root, path.resolve(binding.root, file));
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
      throw new Error("File is outside the working copy");
  }
  if (value.action === "restore")
    return {
      output: await run(["restore", `--source=${value.revision}`, "--worktree", "--", ...files]),
    };
  for (const file of files) {
    if (!snapshot.files.some((entry) => entry.path === file || entry.previousPath === file))
      throw new VcsError({ code: "outdated", message: `File is no longer changed: ${file}` });
  }
  if (value.action === "stage") return { output: await run(["add", "--all", "--", ...files]) };
  if (value.action === "unstage")
    return {
      output: await run(
        snapshot.current
          ? ["restore", "--staged", "--", ...files]
          : ["rm", "--cached", "--", ...files],
      ),
    };
  return discardFiles(run, binding, snapshot, files);
}
async function discardFiles(
  run: (args: string[]) => Promise<string>,
  binding: VcsBinding,
  snapshot: VcsSnapshot,
  files: string[],
) {
  const untracked = files.filter((file) =>
    snapshot.files.some((entry) => entry.path === file && entry.status === "??"),
  );
  const tracked = files.filter((file) => !untracked.includes(file));
  // Refuse a parent symlink before deleting an untracked path; never recurse through directories.
  for (const file of untracked) {
    const parts = file.split("/");
    for (let i = 1; i < parts.length; i++) {
      if ((await lstat(path.join(binding.root, ...parts.slice(0, i)))).isSymbolicLink())
        throw new Error("Refusing to discard through a symbolic link");
    }
  }
  if (tracked.length) {
    const revision = snapshot.current?.id;
    const existing = revision
      ? (await run(["ls-tree", "-r", "--name-only", "-z", revision, "--", ...tracked]))
          .split("\0")
          .filter(Boolean)
      : [];
    const added = tracked.filter((file) => !existing.includes(file));
    if (existing.length)
      await run(["restore", `--source=${revision}`, "--staged", "--worktree", "--", ...existing]);
    if (added.length) await run(["rm", "--force", "--", ...added]);
  }
  for (const file of untracked) await rm(path.join(binding.root, file));
  return { output: "" };
}
