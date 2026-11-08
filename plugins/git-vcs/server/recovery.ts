import { metadata, writeCopyMetadata } from "./working-copy-metadata.js";
import { refName } from "../shared/actions.js";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  VcsError,
  listUnpreservedFiles,
  type VcsContext,
  type VcsWorkingCopyRecovery,
  type VcsProviderRegistration,
} from "@getpaseo/plugin/server/vcs";
import type { VcsWorkingCopyRecord } from "@getpaseo/plugin";

const oid = z.string().regex(/^[a-f0-9]{40,64}$/);
const saved = z.object({
  version: z.literal(1),
  data: z.object({
    head: oid,
    branch: refName.optional(),
    metadata: metadata.optional(),
    branchConfig: z
      .object({
        remote: z.string().optional(),
        merge: z.string().optional(),
        pushRemote: z.string().optional(),
      })
      .optional(),
    revision: oid,
    anchor: z.string().regex(/^refs\/paseo\/recovery\/[a-f0-9]{64}$/),
    dirty: z.boolean(),
    version: z.string(),
  }),
});
interface Dependencies {
  provider(): VcsProviderRegistration;
  git(cwd: string, args: string[], context: VcsContext): Promise<string>;
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
export function createGitRecovery(deps: Dependencies): VcsWorkingCopyRecovery {
  const { provider, git } = deps;
  function repository(record: VcsWorkingCopyRecord, args: string[], context: VcsContext) {
    return git(
      path.dirname(record.binding.repositoryId),
      ["--git-dir", record.binding.repositoryId, ...args],
      context,
    );
  }
  async function validate(record: VcsWorkingCopyRecord, context: VcsContext): Promise<void> {
    const detection = await provider().detect(record.binding.root, context);
    if (detection.status === "unavailable") throw new VcsError(detection.error);
    if (
      detection.status !== "available" ||
      detection.binding.repositoryId !== record.binding.repositoryId ||
      detection.binding.root !== record.binding.root
    )
      throw new VcsError({ code: "outdated", message: "Working copy identity changed" });
    const gitDirectory = (
      await git(record.binding.root, ["rev-parse", "--path-format=absolute", "--git-dir"], context)
    ).trim();
    if (path.resolve(gitDirectory) === path.resolve(record.binding.repositoryId))
      throw new Error("Refusing to remove the main Git working copy");
  }
  async function anchor(record: VcsWorkingCopyRecord, context: VcsContext): Promise<void> {
    const data = saved.parse(record.recovery).data;
    const revision = (
      await repository(record, ["rev-parse", "--verify", data.anchor], context)
    ).trim();
    if (revision !== data.revision)
      throw new VcsError({
        code: "outdated",
        message: "The Git recovery reference is missing or changed",
      });
  }
  async function unpreserved(record: VcsWorkingCopyRecord, context: VcsContext): Promise<void> {
    const tracked = (await git(record.binding.root, ["ls-files", "--cached", "-z"], context))
      .split("\0")
      .filter(Boolean);
    const paths = await listUnpreservedFiles({
      root: record.binding.root,
      tracked,
      metadata: [".git"],
      signal: context.signal,
    });
    if (paths.length)
      throw new VcsError({
        code: "conflict",
        message: `Directory retained: ignored or untracked files are not saved: ${paths.join(", ")}`,
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
      await unpreserved(record, context);
      const snapshot = await provider().snapshot(record.binding, context);
      if (!snapshot.current)
        throw new Error("Cannot archive a Git working copy without a revision");
      if (snapshot.files.some((file) => file.conflict))
        throw new VcsError({
          code: "conflict",
          message: "Resolve Git conflicts before removing this working copy",
        });
      const branch =
        (
          await git(
            record.binding.root,
            ["symbolic-ref", "--quiet", "--short", "HEAD"],
            context,
          ).catch(() => "")
        ).trim() || undefined;
      const branchConfig: { remote?: string; merge?: string; pushRemote?: string } = {};
      if (branch)
        for (const key of ["remote", "merge", "pushRemote"] as const) {
          const value = (
            await git(
              record.binding.root,
              ["config", "--get", `branch.${branch}.${key}`],
              context,
            ).catch(() => "")
          ).trim();
          if (value) branchConfig[key] = value;
        }
      const directory = (
        await git(record.binding.root, ["rev-parse", "--absolute-git-dir"], context)
      ).trim();
      const raw = await readFile(path.join(directory, "paseo", "worktree.json"), "utf8").catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return undefined;
          throw error;
        },
      );
      if (raw && raw.length > 65536) throw new Error("Working copy metadata is too large");
      const copyMetadata = raw ? metadata.parse(JSON.parse(raw)) : undefined;
      const stash = (
        await git(
          record.binding.root,
          [
            "-c",
            "user.name=Paseo",
            "-c",
            "user.email=paseo@localhost",
            "stash",
            "create",
            "Paseo working-copy recovery",
          ],
          context,
        )
      ).trim();
      const revision = stash || snapshot.current.id;
      const anchorName = `refs/paseo/recovery/${createHash("sha256").update(context.operationId).digest("hex")}`;
      await repository(
        record,
        ["update-ref", anchorName, revision, "0".repeat(revision.length)],
        context,
      );
      return {
        ...record,
        recoveryError: undefined,
        recovery: {
          version: 1,
          data: {
            head: snapshot.current.id,
            ...(branch ? { branch, branchConfig } : {}),
            ...(copyMetadata ? { metadata: copyMetadata } : {}),
            revision,
            anchor: anchorName,
            dirty: Boolean(stash),
            version: snapshot.version,
          },
        },
      };
    },
    async remove(record, context) {
      await validate(record, context);
      await anchor(record, context);
      await unpreserved(record, context);
      const snapshot = await provider().snapshot(record.binding, context);
      if (snapshot.version !== saved.parse(record.recovery).data.version)
        throw new VcsError({
          code: "outdated",
          message: "Working copy changed after its recovery snapshot; directory retained",
        });
      await repository(
        record,
        ["worktree", "remove", "--force", "--", record.binding.root],
        context,
      );
      return record;
    },
    async restore(record, context) {
      if (await exists(record.binding.root)) {
        if (record.state === "restoring")
          throw new VcsError({
            code: "outdated",
            message:
              "A previous restore did not finish; the partial directory is retained for inspection",
          });
        await validate(record, context);
        return record;
      }
      await anchor(record, context);
      const data = saved.parse(record.recovery).data;
      await mkdir(path.dirname(record.binding.root), { recursive: true });
      await repository(record, ["worktree", "prune"], context);
      if (data.branch) {
        const head = (
          await repository(
            record,
            ["rev-parse", "--verify", `refs/heads/${data.branch}`],
            context,
          ).catch(() => "")
        ).trim();
        if (head && head !== data.head)
          throw new VcsError({
            code: "outdated",
            message:
              "The saved branch moved after archive; restore it to the saved revision before retrying",
          });
        await repository(
          record,
          head
            ? ["worktree", "add", "--", record.binding.root, data.branch]
            : [
                "worktree",
                "add",
                "-b",
                data.branch,
                "--no-track",
                "--",
                record.binding.root,
                data.head,
              ],
          context,
        );
        if (!head && data.branchConfig)
          for (const [key, value] of Object.entries(data.branchConfig))
            if (value !== undefined)
              await git(
                record.binding.root,
                ["config", `branch.${data.branch}.${key}`, value],
                context,
              );
      } else {
        // COMPAT(gitDetachedRecovery): v0.15.2; old recovery envelopes have no branch identity.
        await repository(
          record,
          ["worktree", "add", "--detach", "--", record.binding.root, data.head],
          context,
        );
      }
      if (data.metadata) await writeCopyMetadata(record.binding.root, data.metadata, context);
      if (data.dirty)
        await git(record.binding.root, ["stash", "apply", "--index", data.revision], context);
      return { ...record, recoveryError: undefined };
    },
    async release(record, context) {
      if (!record.recovery) return record;
      await anchor(record, context);
      const data = saved.parse(record.recovery).data;
      await repository(record, ["update-ref", "-d", data.anchor, data.revision], context);
      return { ...record, recovery: undefined, recoveryError: undefined };
    },
  };
}
