import { lstat } from "node:fs/promises";
import { metadata, copyRecordData, writeCopyMetadata } from "./working-copy-metadata.js";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import {
  VcsError,
  type VcsContext,
  type VcsHostApi,
  type VcsProviderRegistration,
} from "@getpaseo/plugin/server/vcs";
import type { VcsBinding, VcsWorkingCopyCreate } from "@getpaseo/plugin";
import {
  workingCopyOptions,
  sourceInput,
  preparedSource,
  type SourceSelection,
  type PreparedSource,
  type ResolvedSource,
} from "../shared/working-copy.js";
import { oid, refName } from "../shared/actions.js";
import { git } from "./commands.js";
import { createGitRecovery } from "./recovery.js";

type Resolve = VcsHostApi["resolveChangeRequest"];
function outdated(message: string): never {
  throw new VcsError({ code: "outdated", message });
}
async function remoteUrl(binding: VcsBinding, name: string, context: VcsContext) {
  refName.parse(name);
  return (await git(binding.root, ["remote", "get-url", "--", name], context)).trim();
}
async function remoteRevision(
  cwd: string,
  fetch: { url: string; ref: string },
  context: VcsContext,
) {
  await git(cwd, ["check-ref-format", fetch.ref], context);
  const rows = (await git(cwd, ["ls-remote", "--refs", "--", fetch.url, fetch.ref], context))
    .trim()
    .split("\n")
    .map((line) => line.split(/\s+/))
    .filter((row) => row[1] === fetch.ref);
  if (rows.length !== 1)
    outdated("The selected remote ref is missing or ambiguous; select the source again");
  return oid.parse(rows[0]![0]);
}
async function branchFetch(binding: VcsBinding, ref: string, context: VcsContext) {
  if (ref.startsWith("refs/heads/")) return undefined;
  if (!ref.startsWith("refs/remotes/")) throw new Error("Select a qualified branch ref");
  const remotes = (await git(binding.root, ["remote"], context))
    .trim()
    .split("\n")
    .sort((a, b) => b.length - a.length);
  const remote = remotes.find((name) => ref.startsWith(`refs/remotes/${name}/`));
  if (!remote) outdated("The selected remote no longer exists");
  return {
    url: await remoteUrl(binding, remote, context),
    ref: `refs/heads/${ref.slice(`refs/remotes/${remote}/`.length)}`,
  };
}
export async function resolveGitSource(
  binding: VcsBinding,
  selection: SourceSelection,
  context: VcsContext,
  resolve?: Resolve,
): Promise<ResolvedSource> {
  if (selection.kind === "branch") {
    const fetch = await branchFetch(binding, selection.ref, context);
    const revision = fetch
      ? await remoteRevision(binding.root, fetch, context)
      : oid.parse(
          (
            await git(binding.root, ["rev-parse", "--verify", `${selection.ref}^{commit}`], context)
          ).trim(),
        );
    return {
      revision,
      data: { version: 2, data: { source: { ...selection, ...(fetch ? { fetch } : {}) } } },
    };
  }
  if (!resolve) throw new Error("Forge checkout resolution is unavailable");
  const repositoryUrl = await remoteUrl(binding, "origin", context);
  const target = await resolve({
    cwd: binding.root,
    repositoryUrl,
    forge: selection.forge,
    number: selection.number,
  });
  let last: unknown;
  for (const candidate of target.checkoutRefs) {
    try {
      const fetch = {
        url: await remoteUrl(binding, candidate.remoteName ?? "origin", context),
        ref: candidate.remoteRef,
      };
      const revision = await remoteRevision(binding.root, fetch, context);
      return {
        revision,
        data: {
          version: 2,
          data: { source: { kind: "change-request", repositoryUrl, target, fetch } },
        },
      };
    } catch (error) {
      if (context.signal.aborted) throw error;
      last = error;
    }
  }
  throw new VcsError({
    code: "remote",
    message: last instanceof Error ? last.message : "No checkout ref is available",
  });
}
async function validateSource(
  binding: VcsBinding,
  source: PreparedSource,
  revision: string,
  context: VcsContext,
  resolve?: Resolve,
) {
  const selection: SourceSelection =
    source.kind === "branch"
      ? { kind: "branch", ref: source.ref }
      : {
          kind: "change-request",
          forge: source.target.forge,
          number: source.target.changeRequestNumber,
        };
  const current = await resolveGitSource(binding, selection, context, resolve);
  if (
    current.revision !== revision ||
    current.data.version !== 2 ||
    JSON.stringify(preparedSource.parse(current.data.data.source)) !==
      JSON.stringify(preparedSource.parse(source))
  )
    outdated(
      "The selected checkout source changed; select it again before creating a working copy",
    );
}
async function configurePublication(
  root: string,
  branch: string,
  remote: string,
  source: Extract<PreparedSource, { kind: "change-request" }>,
  context: VcsContext,
) {
  const target = source.target;
  if (!target.pushRemoteUrl && !target.trackOriginHead) return undefined;

  await git(
    root,
    ["config", `remote.${remote}.push`, `HEAD:refs/heads/${target.headRef}`],
    context,
  );
  await git(
    root,
    [
      "config",
      `remote.${remote}.fetch`,
      `+refs/heads/${target.headRef}:refs/remotes/${remote}/${target.headRef}`,
    ],
    context,
  );
  await git(root, ["config", `branch.${branch}.pushRemote`, remote], context);
  // A deleted fork branch still permits checkout through the forge's pull ref. Never invent an upstream.
  const fetch = {
    url: target.pushRemoteUrl ?? source.repositoryUrl,
    ref: `refs/heads/${target.headRef}`,
  };
  try {
    await remoteRevision(root, fetch, context);
    await git(
      root,
      [
        "fetch",
        "--no-tags",
        "--no-write-fetch-head",
        "--",
        remote,
        `+${fetch.ref}:refs/remotes/${remote}/${target.headRef}`,
      ],
      context,
    );
    await git(
      root,
      ["branch", "--set-upstream-to", `${remote}/${target.headRef}`, branch],
      context,
    );
  } catch (error) {
    if (context.signal.aborted || !(error instanceof VcsError && error.problem.code === "outdated"))
      throw error;
  }
  return remote;
}
function copyMetadata(source: PreparedSource | undefined, branch: string, revision: string) {
  const baseRef = source?.kind === "branch" ? source.ref : (source?.target.baseRefName ?? revision);
  return {
    version: 2,
    baseRef,
    baseRefName: (source?.kind === "branch" && source.fetch ? source.fetch.ref : baseRef)
      .replace(/^refs\/heads\//, "")
      .replace(/^refs\/remotes\/[^/]+\//, ""),
    changeRequestLookupTarget: {
      headRef: source?.kind === "change-request" ? source.target.headRef : branch,
      localBranchName: branch,
      ...(source?.kind === "change-request"
        ? {
            changeRequestNumber: source.target.changeRequestNumber,
            headRepositoryOwner: source.target.headRepositoryOwner,
          }
        : {}),
    },
  } satisfies z.infer<typeof metadata>;
}
async function prepareCopy(
  binding: VcsBinding,
  input: VcsWorkingCopyCreate,
  context: VcsContext,
  resolve?: Resolve,
) {
  const options = input.data === undefined ? undefined : workingCopyOptions.parse(input.data);
  const source = options?.version === 2 ? options.data.source : undefined;
  oid.parse(input.revision);
  if (!path.isAbsolute(input.root) || path.resolve(input.root) === binding.root)
    throw new Error("Invalid working copy destination");
  refName.parse(input.name);
  if (
    await lstat(input.root).then(
      () => true,
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return false;
        throw error;
      },
    )
  )
    outdated("The working copy destination already exists");
  if (source) await validateSource(binding, source, input.revision, context, resolve);
  const candidate =
    source?.kind === "change-request"
      ? (source.target.localBranchName ?? source.target.headRef)
      : input.name;
  let branch = options?.data.branch ?? candidate;
  await git(binding.root, ["check-ref-format", "--branch", branch], context);
  const existing = (
    await git(
      binding.root,
      ["show-ref", "--verify", "--hash", `refs/heads/${branch}`],
      context,
    ).catch(() => "")
  ).trim();
  if (existing) {
    if (options?.data.branch || source?.kind !== "change-request")
      outdated("The requested new branch already exists");
    branch = `${branch}-${input.name}`;
  }
  return { source, branch, meta: copyMetadata(source, branch, input.revision) };
}
export function createGitWorkingCopies(
  provider: () => VcsProviderRegistration,
  resolve?: Resolve,
): NonNullable<VcsProviderRegistration["workingCopies"]> {
  return {
    recovery: createGitRecovery({ provider, git }),
    async resolveSource(binding, input, context) {
      return resolveGitSource(binding, sourceInput.parse(input).data, context, resolve);
    },
    async create(binding, input, context) {
      const { source, branch, meta } = await prepareCopy(binding, input, context, resolve);
      const anchor = `refs/paseo/creation/${randomUUID()}`;
      const cleanup = { signal: new AbortController().signal };
      let branchCreated = false;
      let created = false;
      let remote: string | undefined;
      try {
        if (source?.fetch) {
          await git(
            binding.root,
            [
              "fetch",
              "--no-tags",
              "--no-write-fetch-head",
              "--no-recurse-submodules",
              "--",
              source.fetch.url,
              `+${source.fetch.ref}:${anchor}`,
            ],
            context,
          );
          if (
            (await git(binding.root, ["rev-parse", "--verify", anchor], context)).trim() !==
            input.revision
          )
            outdated("The remote changed during fetch; select the source again");
        }
        await git(
          binding.root,
          ["update-ref", `refs/heads/${branch}`, input.revision, "0".repeat(input.revision.length)],
          context,
        );
        branchCreated = true;
        await git(binding.root, ["worktree", "add", "--", input.root, branch], context);
        created = true;
        if ((await git(input.root, ["rev-parse", "HEAD"], context)).trim() !== input.revision)
          outdated("Branch changed during checkout");
        if (
          source?.kind === "change-request" &&
          (source.target.pushRemoteUrl || source.target.trackOriginHead)
        ) {
          const name = `paseo-copy-${input.name}`;
          await git(
            input.root,
            ["remote", "add", name, source.target.pushRemoteUrl ?? source.repositoryUrl],
            context,
          );
          remote = name;
          await configurePublication(input.root, branch, name, source, context);
        }
        await writeCopyMetadata(input.root, meta, context);
        await git(binding.root, ["update-ref", "-d", anchor], cleanup);
        return {
          binding: { ...binding, workingCopyId: input.root, root: input.root, cwd: input.root },
          owned: true,
          data: {
            version: 2,
            data: {
              branch,
              revision: input.revision,
              metadata: meta,
              ...(remote ? { remote } : {}),
            },
          },
        };
      } catch (error) {
        try {
          await git(binding.root, ["update-ref", "-d", anchor], cleanup);
          if (created)
            await git(binding.root, ["worktree", "remove", "--force", "--", input.root], cleanup);
          if (branchCreated)
            await removeCreatedBranch(binding.root, branch, input.revision, cleanup);
          if (remote) await git(binding.root, ["remote", "remove", remote], cleanup);
        } catch (cleanupError) {
          throw new Error(
            `Checkout failed: ${String(error)}; cleanup failed: ${String(cleanupError)}. Inspect ${input.root} before retrying.`,
            { cause: cleanupError },
          );
        }
        throw error;
      }
    },
    async rollback(binding, record, context) {
      const data = copyRecordData.parse(record.data).data;
      await git(
        binding.root,
        ["worktree", "remove", "--force", "--", record.binding.root],
        context,
      );
      await removeCreatedBranch(binding.root, data.branch, data.revision, context);
      if (data.remote) await git(binding.root, ["remote", "remove", data.remote], context);
    },
  };
}

async function removeCreatedBranch(
  cwd: string,
  branch: string,
  revision: string,
  context: VcsContext,
) {
  if (
    (
      await git(cwd, ["for-each-ref", "--format=%(worktreepath)", `refs/heads/${branch}`], context)
    ).trim()
  )
    outdated("Created branch is now used by another working copy; branch retained");
  await git(cwd, ["update-ref", "-d", `refs/heads/${branch}`, revision], context);
  await git(cwd, ["config", "--remove-section", `branch.${branch}`], context).catch((error) => {
    if (!(error instanceof Error && "code" in error && error.code === 128)) throw error;
  });
}
