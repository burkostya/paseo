import { createHash } from "node:crypto";
import { lstat, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { execCommand } from "@getpaseo/plugin/server";
import {
  VcsError,
  listUnpreservedFiles,
  type VcsContext,
  type VcsWorkingCopyRecovery,
  type VcsProviderRegistration,
} from "@getpaseo/plugin/server/vcs";
import type { VcsWorkingCopyRecord } from "@getpaseo/plugin";

const saved = z.object({
  version: z.literal(1),
  data: z.object({
    revision: z.string().regex(/^[0-9a-f]{40,64}$/),
    anchor: z.string().regex(/^refs\/paseo\/recovery\/[a-f0-9]{64}$/),
    gitDirectory: z.string(),
    repositoryRoot: z.string(),
    name: z.string(),
    operation: z.string(),
  }),
});
interface Dependencies {
  provider(): VcsProviderRegistration;
  run(cwd: string, args: string[], context: VcsContext, read?: boolean): Promise<string>;
}
interface Workspace {
  name: string;
  root: string | null;
}
async function exists(root: string): Promise<boolean> {
  try {
    await lstat(root);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}
async function git(gitDirectory: string, args: string[], context: VcsContext): Promise<string> {
  try {
    return (
      await execCommand("git", ["--git-dir", gitDirectory, ...args], {
        cwd: path.dirname(gitDirectory),
        signal: context.signal,
        timeout: 30_000,
        maxBuffer: 20 * 1024 * 1024,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
      })
    ).stdout;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      throw new VcsError({
        code: "unavailable",
        message: "Git is required for durable recovery of Git-backed jj workspaces",
      });
    throw error;
  }
}
export function createJjRecovery({ run, provider }: Dependencies): VcsWorkingCopyRecovery {
  async function backend(root: string, context: VcsContext): Promise<string> {
    const directory = (await run(root, ["git", "root"], context, true)).trim();
    return (
      await git(directory, ["rev-parse", "--path-format=absolute", "--git-common-dir"], context)
    ).trim();
  }
  async function readRef(
    directory: string,
    ref: string,
    context: VcsContext,
  ): Promise<string | null> {
    try {
      return (await git(directory, ["rev-parse", "--verify", "--quiet", ref], context)).trim();
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === 1) return null;
      throw error;
    }
  }
  async function workspaces(root: string, context: VcsContext): Promise<Workspace[]> {
    const output = await run(
      root,
      ["workspace", "list", "-T", 'json(name) ++ "\\n" ++ json(root) ++ "\\n"'],
      context,
      true,
    );
    const fields = output
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const entries: Workspace[] = [];
    for (let index = 0; index + 1 < fields.length; index += 2)
      entries.push({
        name: z.string().parse(fields[index]),
        root: z
          .string()
          .nullable()
          .parse(fields[index + 1]),
      });
    return entries;
  }
  async function repository(record: VcsWorkingCopyRecord, context: VcsContext): Promise<string> {
    const stored = saved.safeParse(record.recovery);
    const candidates = [
      stored.success ? stored.data.data.repositoryRoot : undefined,
      record.source?.root,
      path.dirname(path.dirname(record.binding.repositoryId)),
    ];
    for (const root of new Set(candidates)) {
      if (!root || !(await exists(root))) continue;
      const detection = await provider().detect(root, context);
      if (detection.status === "unavailable") throw new VcsError(detection.error);
      if (
        detection.status === "available" &&
        detection.binding.repositoryId === record.binding.repositoryId &&
        root !== record.binding.root
      )
        return root;
    }
    throw new VcsError({
      code: "unavailable",
      message: "The source jj repository needed for recovery is unavailable",
    });
  }
  async function validate(record: VcsWorkingCopyRecord, context: VcsContext): Promise<void> {
    const within = path.relative(record.binding.root, record.binding.repositoryId);
    if (within && !within.startsWith(`..${path.sep}`) && !path.isAbsolute(within))
      throw new Error("Refusing to remove the main jj repository");
    const dotGit = path.join(record.binding.root, ".git");
    if (await exists(dotGit)) {
      if ((await lstat(dotGit)).isDirectory())
        throw new Error("Directory retained: an independent Git repository is present");
    }
    const detection = await provider().detect(record.binding.root, context);
    if (detection.status === "unavailable") throw new VcsError(detection.error);
    if (
      detection.status !== "available" ||
      detection.binding.repositoryId !== record.binding.repositoryId ||
      detection.binding.root !== record.binding.root
    )
      throw new VcsError({ code: "outdated", message: "Working copy identity changed" });
    const entries = await workspaces(record.binding.root, context);
    if (!entries.some((entry) => entry.root && path.resolve(entry.root) === record.binding.root))
      throw new VcsError({
        code: "outdated",
        message: "The jj workspace registration is missing; retain its directory for inspection",
      });
  }
  async function anchor(record: VcsWorkingCopyRecord, context: VcsContext): Promise<string> {
    const data = saved.parse(record.recovery).data;
    const root = await repository(record, context);
    const actualGit = await backend(root, context);
    if (path.resolve(actualGit) !== path.resolve(data.gitDirectory))
      throw new VcsError({ code: "outdated", message: "The jj Git backend changed" });
    const target = (
      await git(data.gitDirectory, ["rev-parse", "--verify", data.anchor], context)
    ).trim();
    if (target !== data.revision)
      throw new VcsError({
        code: "outdated",
        message: "The jj recovery reference is missing or changed",
      });
    return root;
  }
  async function unchanged(record: VcsWorkingCopyRecord, context: VcsContext): Promise<void> {
    await validate(record, context);
    const data = saved.parse(record.recovery).data;
    await run(record.binding.root, ["status"], context);
    const revision = (
      await run(
        record.binding.root,
        ["--at-op", "@", "log", "-r", "@", "--no-graph", "-T", "commit_id"],
        context,
        true,
      )
    ).trim();
    if (revision !== data.revision)
      throw new VcsError({
        code: "outdated",
        message: "Working copy changed after the recovery snapshot; directory retained",
      });
    const localFiles = provider().localFiles;
    if (!localFiles) throw new Error("The jj provider must support tracked file queries");
    const tracked = await localFiles(record.binding, { kind: "tracked" }, context);
    const unsaved = await listUnpreservedFiles({
      root: record.binding.root,
      tracked,
      metadata: [".jj", ".git"],
      signal: context.signal,
    });
    if (unsaved.length)
      throw new VcsError({
        code: "conflict",
        message: `Directory retained: files outside the jj snapshot: ${unsaved.join(", ")}`,
      });
  }
  return {
    async inspect(record, context) {
      if (await exists(record.binding.root)) {
        if (record.state === "restoring")
          throw new VcsError({
            code: "outdated",
            message:
              "A previous restore did not finish; move the partial directory aside before retrying",
          });
        return validate(record, context);
      }
      if (!record.recovery)
        throw new VcsError({
          code: "unavailable",
          message: "No durable recovery snapshot is available for this missing working copy",
        });
      await anchor(record, context);
    },
    async prepareRemoval(record, context) {
      await validate(record, context);
      const repositoryRoot = await repository(record, context);
      const snapshot = await provider().snapshot(record.binding, context);
      if (snapshot.state === "stale")
        throw new VcsError({
          code: "stale",
          message: "Update the stale jj workspace before archiving",
          recoveryAction: "update-stale",
        });
      if (!snapshot.current) throw new Error("Missing jj working-copy revision");
      const entries = await workspaces(record.binding.root, context);
      const current = entries.filter(
        (entry) => entry.root && path.resolve(entry.root) === record.binding.root,
      );
      if (current.length !== 1) throw new Error("Ambiguous jj working-copy name");
      const name = current[0]!.name;
      const anchorName = `refs/paseo/recovery/${createHash("sha256").update(context.operationId).digest("hex")}`;
      const gitDirectory = await backend(record.binding.root, context);
      await git(
        gitDirectory,
        ["update-ref", anchorName, snapshot.current.id, "0".repeat(snapshot.current.id.length)],
        context,
      );
      return {
        ...record,
        recoveryError: undefined,
        recovery: {
          version: 1,
          data: {
            revision: snapshot.current.id,
            anchor: anchorName,
            gitDirectory,
            repositoryRoot,
            name,
            operation: snapshot.version,
          },
        },
      };
    },
    async remove(record, context) {
      await anchor(record, context);
      await unchanged(record, context);
      await run(record.binding.root, ["workspace", "forget"], context, true);
      await rm(record.binding.root, { recursive: true });
      return record;
    },
    async restore(record, context) {
      if (await exists(record.binding.root)) {
        if (record.state === "restoring")
          throw new VcsError({
            code: "outdated",
            message:
              "A previous restore did not finish; move the partial directory aside before retrying",
          });
        await validate(record, context);
        return record;
      }
      const root = await anchor(record, context);
      const data = saved.parse(record.recovery).data;
      const registered = (await workspaces(root, context)).find(
        (entry) => entry.name === data.name,
      );
      if (registered) {
        if (!registered.root || path.resolve(registered.root) !== record.binding.root)
          throw new VcsError({
            code: "outdated",
            message: "The saved jj workspace name is now used by another working copy",
          });
        await run(root, ["workspace", "forget", "--", data.name], context, true);
      }
      // Native refs do not follow jj rewrites. Import briefly to rebuild the jj index after operation GC.
      const importName = `paseo-recovery-import-${data.anchor.split("/").at(-1)}`;
      const importRef = `refs/heads/${importName}`;
      const existingImport = await readRef(data.gitDirectory, importRef, context);
      if (existingImport && existingImport !== data.revision)
        throw new VcsError({
          code: "outdated",
          message: "The temporary recovery import reference changed",
        });
      if (!existingImport)
        await git(
          data.gitDirectory,
          ["update-ref", importRef, data.revision, "0".repeat(data.revision.length)],
          context,
        );
      try {
        await run(root, ["git", "import"], context, true);
      } finally {
        await run(root, ["bookmark", "delete", "--", `exact:${importName}`], context, true);
        await git(data.gitDirectory, ["update-ref", "-d", importRef], context);
        await run(root, ["git", "import"], context, true);
      }
      await mkdir(path.dirname(record.binding.root), { recursive: true });
      await run(
        root,
        [
          "workspace",
          "add",
          "--no-colocate",
          "--name",
          data.name,
          "--revision",
          data.revision,
          "--",
          record.binding.root,
        ],
        context,
      );
      await run(record.binding.root, ["edit", "--", data.revision], context);
      return { ...record, recoveryError: undefined };
    },
    async release(record, context) {
      if (!record.recovery) return record;
      const data = saved.parse(record.recovery).data;
      const gitDirectory = await backend(record.binding.root, context);
      if (path.resolve(gitDirectory) !== path.resolve(data.gitDirectory))
        throw new VcsError({ code: "outdated", message: "The jj Git backend changed" });
      const target = await readRef(gitDirectory, data.anchor, context);
      if (target && target !== data.revision)
        throw new VcsError({ code: "outdated", message: "The jj recovery reference changed" });
      if (target)
        await git(gitDirectory, ["update-ref", "-d", data.anchor, data.revision], context);
      return { ...record, recovery: undefined, recoveryError: undefined };
    },
  };
}
