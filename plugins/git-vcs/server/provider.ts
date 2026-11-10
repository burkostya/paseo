import { createComparisonBaseResolver } from "./comparison-base.js";
import {
  gitSavedComparisonSettings,
  gitSnapshotComparisonBase,
  resolveGitBaseName,
} from "../shared/comparison.js";
import { createGitPublication } from "@getpaseo/plugin/server/vcs";
import { withPushMapping } from "./publication.js";
import { createGitWorkingCopies } from "./working-copies.js";
import { gitComparisonData, gitRevisionComparisonData } from "../shared/comparison.js";
import { gitActions, executeGitAction } from "./actions.js";
import {
  createGitComparisons,
  comparisonData,
  untrackedPatch,
  comparisonPatch,
} from "./comparisons.js";
import { oid } from "../shared/actions.js";
const comparisons = createGitComparisons();
import { createHash } from "node:crypto";
import { realpath, lstat } from "node:fs/promises";
import path from "node:path";
import { git } from "./commands.js";
import type { VcsContext, VcsProviderRegistration } from "@getpaseo/plugin/server/vcs";
import {
  VcsError,
  listGitIgnoredFiles,
  fingerprintVcsPaths,
  gitObservationIgnoredDirectories,
} from "@getpaseo/plugin/server/vcs";
import type { VcsRevision } from "@getpaseo/plugin";
import { z } from "zod";

async function revisions(
  cwd: string,
  limit: number,
  context: VcsContext,
  start?: string,
): Promise<VcsRevision[]> {
  const output = await git(
    cwd,
    [
      "log",
      `--max-count=${limit}`,
      "--format=%H%x00%P%x00%an%x00%ae%x00%aI%x00%B%x00",
      ...(start ? [start] : []),
    ],
    context,
  );
  const fields = output.split("\0");
  const result: VcsRevision[] = [];
  for (let i = 0; i + 5 < fields.length; i += 6) {
    result.push({
      id: fields[i]!.trim(),
      parents: fields[i + 1]!.split(" ").filter(Boolean),
      author: { name: fields[i + 2]!, email: fields[i + 3]! },
      timestamp: fields[i + 4]!,
      description: fields[i + 5]!,
      conflict: false,
    });
  }
  return result;
}
export const gitProvider: VcsProviderRegistration = {
  async validateComparisonSettings(_binding, value) {
    return gitSavedComparisonSettings.parse(value);
  },
  id: "git",
  label: "Git",
  publication: withPushMapping(
    createGitPublication({
      git: (binding, args, context) => git(binding.root, args, context),
      head(snapshot, name) {
        const ref = snapshot.refs.find((item) => item.id === `refs/heads/${name}`);
        if (!ref || ref.targets.length !== 1)
          throw new VcsError({ code: "outdated", message: "Select an existing local branch" });
        return ref.targets[0]!;
      },
      async canArchive(_binding, target, snapshot) {
        return (
          snapshot.state === "ready" &&
          snapshot.files.length === 0 &&
          snapshot.current?.id === target.headRevision
        );
      },
      async push(binding, target, _snapshot, context) {
        await git(
          binding.root,
          [
            "push",
            "--",
            target.repositoryUrl,
            `${target.headRevision}:refs/heads/${target.headRef}`,
          ],
          context,
        );
      },
    }),
  ),
  async localFiles(binding, query, context) {
    if (query.kind === "tracked")
      return (await git(binding.root, ["ls-files", "--cached", "--deduplicate", "-z"], context))
        .split("\0")
        .filter(Boolean);
    return listGitIgnoredFiles({
      cwd: binding.root,
      patterns: query.patterns,
      signal: context.signal,
    });
  },
  workingCopies: createGitWorkingCopies(() => gitProvider),
  async detect(cwd, context) {
    try {
      const root = (await git(cwd, ["rev-parse", "--show-toplevel"], context)).trim();
      const common = (
        await git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"], context)
      ).trim();
      return {
        status: "available",
        binding: {
          providerId: "git",
          repositoryId: await realpath(common),
          workingCopyId: root,
          root,
          cwd: path.resolve(cwd),
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/not a git repository/i.test(message)) return { status: "absent" };
      return {
        status: "unavailable",
        error: { code: /ENOENT/.test(message) ? "unavailable" : "provider", message },
      };
    }
  },
  async observation(binding, context) {
    const directory = (
      await git(binding.root, ["rev-parse", "--absolute-git-dir"], context)
    ).trim();
    const common = binding.repositoryId;
    const roots = [...new Set([common, directory])].map((root) => ({
      path: root,
      scope: "repository" as const,
      ignore: ["objects", "logs", "worktrees", "hooks", "lfs", "rr-cache"].map((name) =>
        path.join(root, name),
      ),
    }));
    const metadata = [...new Set([common, directory])].flatMap((root) =>
      [
        "HEAD",
        "index",
        "config",
        "packed-refs",
        "refs",
        "info/exclude",
        "paseo/worktree.json",
        "MERGE_HEAD",
        "CHERRY_PICK_HEAD",
        "rebase-merge",
        "rebase-apply",
      ].map((name) => path.join(root, name)),
    );
    return {
      fingerprint: await fingerprintVcsPaths(metadata),
      roots: [
        {
          path: binding.root,
          scope: "working-copy" as const,
          kind: "files" as const,
          ignore: [
            path.join(binding.root, ".git"),
            path.join(binding.root, ".jj"),
            ...(await gitObservationIgnoredDirectories({
              cwd: binding.root,
              signal: context.signal,
            })),
          ],
        },
        ...roots,
      ],
    };
  },
  async snapshot(binding, context) {
    const output = await git(
      binding.root,
      ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
      context,
    );
    const entries = output.split("\0").filter(Boolean);
    const files: Array<{ path: string; previousPath?: string; status: string; conflict: boolean }> =
      [];
    for (let i = 0; i < entries.length; i++) {
      const code = entries[i]!.slice(0, 2);
      files.push({
        path: entries[i]!.slice(3),
        status: code,
        ...(/[RC]/.test(code) ? { previousPath: entries[++i] } : {}),
        conflict: code.includes("U") || code === "AA" || code === "DD",
      });
    }
    const head = (
      await git(binding.root, ["rev-parse", "--verify", "--quiet", "HEAD"], context).catch(() => "")
    ).trim();
    const refsOutput = await git(
      binding.root,
      [
        "for-each-ref",
        "--format=%(refname)%00%(objectname)%00",
        "refs/heads",
        "refs/remotes",
        "refs/tags",
      ],
      context,
    );
    const refFields = refsOutput.split("\0");
    const refs = [];
    for (let i = 0; i + 1 < refFields.length; i += 2) {
      const id = refFields[i]!.trim();
      let kind = "tag";
      if (id.startsWith("refs/heads/")) kind = "branch";
      else if (id.startsWith("refs/remotes/")) kind = "remote-branch";
      refs.push({
        id,
        name: id.replace(/^refs\/(heads|remotes|tags)\//, ""),
        kind,
        publishable: kind === "branch",
        targets: [refFields[i + 1]!],
      });
    }
    const branch =
      (
        await git(binding.root, ["symbolic-ref", "--quiet", "--short", "HEAD"], context).catch(
          () => "",
        )
      ).trim() || null;
    const remoteUrl =
      (await git(binding.root, ["remote", "get-url", "origin"], context).catch(() => "")).trim() ||
      null;
    const upstreamRef =
      (
        await git(
          binding.root,
          ["rev-parse", "--symbolic-full-name", "@{upstream}"],
          context,
        ).catch(() => "")
      ).trim() || null;
    const directory = (
      await git(binding.root, ["rev-parse", "--absolute-git-dir"], context)
    ).trim();
    const busy = (
      await Promise.all(
        ["MERGE_HEAD", "rebase-merge", "rebase-apply", "CHERRY_PICK_HEAD"].map(async (name) => {
          try {
            await lstat(path.join(directory, name));
            return true;
          } catch (error) {
            if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
            throw error;
          }
        }),
      )
    ).some(Boolean);
    const staged = await git(
      binding.root,
      ["diff", "--cached", "--no-ext-diff", "--no-textconv", "--binary", "--"],
      context,
    );
    const untracked = await untrackedPatch(
      git,
      binding,
      files.filter((file) => file.status === "??").map((file) => file.path),
      context,
    );
    const unstaged =
      (await git(
        binding.root,
        ["diff", "--no-ext-diff", "--no-textconv", "--binary", "--"],
        context,
      )) + untracked;
    const all = head
      ? (await git(
          binding.root,
          ["diff", "--no-ext-diff", "--no-textconv", "--binary", head, "--"],
          context,
        )) + untracked
      : await untrackedPatch(
          git,
          binding,
          files.map((file) => file.path),
          context,
        );
    const hash = createHash("sha256")
      .update(head)
      .update(branch ?? "")
      .update(upstreamRef ?? "")
      .update(remoteUrl ?? "")
      .update(String(busy))
      .update(output)
      .update(refsOutput)
      .update(staged)
      .update(unstaged)
      .update(all);
    const version = hash.digest("hex");
    comparisons.save(binding, version, { head, all, staged, unstaged });
    const comparison = (mode: "all" | "staged" | "unstaged") => ({
      kind: "working-copy" as const,
      data: { version: 1, data: { version, mode } },
    });
    return {
      binding,
      version,
      workingComparison: comparison("all"),
      comparisons: ["all", "staged", "unstaged"].map((id) => ({
        id,
        comparison: comparison(id as "all" | "staged" | "unstaged"),
      })),
      data: { version: 1, data: { branch, upstreamRef, remoteUrl } },
      current: head ? (await revisions(binding.root, 1, context, head))[0]! : null,
      files,
      refs,
      capabilities: ["history", "diff", "refs", "actions"],
      state: "ready",
      actions: gitActions(files, head, branch, busy),
    };
  },
  async history(binding, input, context) {
    const head = input.version
      ? comparisons.get(binding, input.version).head
      : (
          await git(binding.root, ["rev-parse", "--verify", "--quiet", "HEAD"], context).catch(
            () => "",
          )
        ).trim();
    if (!head && !input.cursor) return { revisions: [] };
    const cursor = input.cursor
      ? z
          .object({ head: oid, offset: z.number().int().nonnegative().max(100_000) })
          .parse(JSON.parse(input.cursor))
      : { head, offset: 0 };
    const rows = await revisions(
      binding.root,
      cursor.offset + input.limit + 1,
      context,
      cursor.head,
    );
    return {
      revisions: rows.slice(cursor.offset, cursor.offset + input.limit),
      cursor:
        rows.length > cursor.offset + input.limit
          ? JSON.stringify({ ...cursor, offset: cursor.offset + input.limit })
          : undefined,
    };
  },
  async diff(binding, comparison, context) {
    let ignoreWhitespace = false;
    if (comparison.kind === "working-copy" && comparison.data?.version === 3) {
      const input = gitRevisionComparisonData.parse(comparison.data).data;
      comparison = input.comparison;
      ignoreWhitespace = input.ignoreWhitespace;
    }
    if (comparison.kind === "working-copy") {
      if (!comparison.data) {
        const snapshot = await gitProvider.snapshot(binding, context);
        return comparisons.get(binding, snapshot.version).all;
      }
      if (comparison.data.version === 2) {
        const input = gitComparisonData.parse(comparison.data).data;
        return comparisonPatch(
          git,
          binding,
          comparisons.get(binding, input.version),
          input,
          context,
        );
      }
      const data = comparisonData.parse(comparison.data).data;
      return comparisons.get(binding, data.version)[data.mode];
    }
    if (comparison.kind === "revision")
      return git(
        binding.root,
        [
          "show",
          "--format=",
          "--first-parent",
          ...(ignoreWhitespace ? ["--ignore-all-space"] : []),
          "--no-ext-diff",
          "--no-textconv",
          "--binary",
          oid.parse(comparison.revision),
          "--",
        ],
        context,
      );
    return git(
      binding.root,
      [
        "diff",
        ...(ignoreWhitespace ? ["--ignore-all-space"] : []),
        "--no-ext-diff",
        "--no-textconv",
        "--binary",
        oid.parse(comparison.from),
        oid.parse(comparison.to),
        "--",
      ],
      context,
    );
  },
  async execute(binding, action, input, context) {
    const snapshot = context.snapshot;
    try {
      return await executeGitAction(git, binding, snapshot, action, input, context);
    } catch (error) {
      if (error instanceof VcsError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      const remote = ["fetch", "push", "pull", "pull-and-push"].includes(action);
      const stdout = error instanceof Error && "stdout" in error ? String(error.stdout) : "";
      let code: "remote" | "provider" | "conflict" = remote ? "remote" : "provider";
      if (/CONFLICT|unmerged/i.test(message + stdout)) code = "conflict";
      throw new VcsError({ code, message: [message, stdout.trim()].filter(Boolean).join("\n") });
    }
  },
};

function publishedHead(
  snapshot: import("@getpaseo/plugin").VcsSnapshot,
  baseRef: string | null,
  branch: string,
): string {
  const remoteBase = baseRef?.replace(/^refs\/remotes\//, "");
  const remote = remoteBase?.split("/")[0];
  if (!remote || !remoteBase?.includes("/"))
    throw new VcsError({ code: "unavailable", message: "PR/MR remote base is unavailable" });
  const headRef = `refs/remotes/${remote}/${branch}`;
  const published = snapshot.refs.find((ref) => ref.id === headRef);
  if (!published || published.targets.length !== 1)
    throw new VcsError({
      code: "unavailable",
      message: `PR/MR head is not available locally: ${headRef}. Fetch it explicitly, then check again.`,
    });
  return published.targets[0];
}

function pinnedBase(snapshot: import("@getpaseo/plugin").VcsSnapshot, name: string): string {
  const exact = resolveGitBaseName(snapshot.refs, name);
  const ref = exact
    ? snapshot.refs.find((item) => item.id === exact || item.name === exact)
    : undefined;
  if (!ref || ref.targets.length !== 1)
    throw new VcsError({
      code: "unavailable",
      message: `Comparison base is unavailable in this snapshot: ${name}`,
    });
  return ref.targets[0];
}

function selectedBase(
  input: import("@getpaseo/plugin").VcsComparisonResolveInput,
  settings: import("@getpaseo/plugin").VcsData | null,
  detected: string | null,
): string | null {
  return (
    input.baseRef ??
    (settings ? gitSavedComparisonSettings.parse(settings).data.baseRef : undefined) ??
    detected
  );
}

export function createGitProvider(
  host: import("@getpaseo/plugin/server/vcs").VcsHostApi,
): VcsProviderRegistration {
  const provider = { ...gitProvider };
  provider.workingCopies = createGitWorkingCopies(() => provider, host.resolveChangeRequest);
  const resolveBase = createComparisonBaseResolver();
  provider.resolveComparison = async (binding, input, settings, context) => {
    const snapshot = await provider.snapshot(binding, context);
    let head = snapshot.current?.id ?? null;
    if (input.mode === "working-copy") {
      if (!snapshot.workingComparison)
        throw new VcsError({
          code: "unavailable",
          message: "Working-copy comparison is unavailable",
        });
      return {
        comparison: snapshot.workingComparison,
        description: "Uncommitted changes",
        baseRef: null,
        baseRevision: head,
        mergeBaseRevision: null,
        headRevision: head,
        sourceUrl: null,
      };
    }
    if (!head) throw new VcsError({ code: "unavailable", message: "Repository has no commits" });
    const facts = await readContext(binding);
    const data = gitSnapshotComparisonBase.shape.data
      .extend({ branch: z.string().nullable() })
      .parse(snapshot.data?.data);
    let sourceUrl: string | null = null;
    let baseRef = selectedBase(input, settings, data.comparisonBase.baseRef);
    if (input.mode === "change-request") {
      if (!facts.changeRequest || facts.changeRequestError || facts.observedHeadRef !== data.branch)
        throw new VcsError({
          code: "unavailable",
          message: facts.changeRequestError ?? "No current PR/MR is available for this workspace",
        });
      if (facts.changeRequest.headRef !== data.branch)
        throw new VcsError({
          code: "outdated",
          message: "The PR/MR head does not match this workspace",
        });
      const resolved = await resolveBase(snapshot, data.branch, facts, context);
      if (resolved.error) throw new VcsError({ code: "unavailable", message: resolved.error });
      baseRef = resolved.baseRef;
      sourceUrl = facts.changeRequest.url;
      head = publishedHead(snapshot, baseRef, facts.changeRequest.headRef);
    }
    if (!baseRef)
      throw new VcsError({
        code: "unavailable",
        message: data.comparisonBase.error ?? "Select a comparison base",
      });
    if (baseRef.startsWith("-") || baseRef.includes("\0"))
      throw new VcsError({ code: "provider", message: "Invalid base ref" });
    const baseRevision = pinnedBase(snapshot, baseRef);
    const mergeBaseRevision = (
      await git(binding.root, ["merge-base", baseRevision, head], context)
    ).trim();
    return {
      comparison: { kind: "range", from: mergeBaseRevision, to: head },
      description: sourceUrl ?? `${baseRef} → ${data.branch ?? head}`,
      baseRef,
      baseRevision,
      mergeBaseRevision,
      headRevision: head,
      sourceUrl,
    };
  };
  const readContext = (binding: import("@getpaseo/plugin").VcsBinding) =>
    host.comparisonContext(binding).catch((error: unknown) => ({
      workingCopy: null,
      changeRequest: null,
      observedHeadRef: null,
      changeRequestError: error instanceof Error ? error.message : String(error),
    }));
  provider.snapshot = async (binding, context) => {
    const snapshot = await gitProvider.snapshot(binding, context);
    const data = z
      .object({
        branch: z.string().nullable(),
        upstreamRef: z.string().nullable(),
        remoteUrl: z.string().nullable(),
      })
      .parse(snapshot.data?.data);
    const facts = await readContext(binding);
    const comparisonBase = await resolveBase(snapshot, data.branch, facts, context);
    const version = createHash("sha256")
      .update(snapshot.version)
      .update(JSON.stringify(comparisonBase))
      .digest("hex");
    const patches = comparisons.get(binding, snapshot.version);
    // The intermediate version is never published. Keep one copy of its frozen patches.
    comparisons.remove(binding, snapshot.version);
    comparisons.save(binding, version, patches);
    const comparison = (mode: "all" | "staged" | "unstaged") => ({
      kind: "working-copy" as const,
      data: { version: 1, data: { version, mode } },
    });
    return {
      ...snapshot,
      version,
      workingComparison: comparison("all"),
      comparisons: (["all", "staged", "unstaged"] as const).map((id) => ({
        id,
        comparison: comparison(id),
      })),
      data: { version: 1, data: { ...data, comparisonBase } },
    };
  };
  provider.observation = async (binding, context) => {
    const plan = await gitProvider.observation!(binding, context);
    const facts = await readContext(binding);
    return {
      ...plan,
      fingerprint: createHash("sha256")
        .update(plan.fingerprint)
        .update(JSON.stringify(facts))
        .digest("hex"),
    };
  };

  return provider;
}
