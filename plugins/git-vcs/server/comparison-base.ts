import { constants } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { parseGitRemoteLocation, type VcsContext } from "@getpaseo/plugin/server/vcs";
import type { VcsComparisonContext, VcsSnapshot } from "@getpaseo/plugin";
import { resolveGitBaseName } from "../shared/comparison.js";
import { copyRecordData } from "./working-copy-metadata.js";
import { git } from "./commands.js";

const storedMetadata = z.object({
  baseRef: z.string().optional(),
  baseRefName: z.string().optional(),
});
async function storedBase(snapshot: VcsSnapshot, facts: VcsComparisonContext, context: VcsContext) {
  if (!facts.workingCopy?.owned) return null;
  const record = copyRecordData.safeParse(facts.workingCopy.data);
  if (record.success && record.data.data.metadata) return record.data.data.metadata.baseRef;
  // COMPAT(gitLegacyBaseMetadata): v0.15.2; read pre-provider owned worktrees until 2027-06-06.
  const directory = (
    await git(snapshot.binding.root, ["rev-parse", "--absolute-git-dir"], context)
  ).trim();
  let file;
  try {
    file = await open(
      path.join(directory, "paseo", "worktree.json"),
      constants.O_RDONLY | constants.O_NONBLOCK,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    const limit = 1024 * 1024;
    const info = await file.stat();
    if (!info.isFile() || info.size > limit) throw new Error("Invalid worktree metadata");
    const buffer = Buffer.alloc(limit + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > limit) throw new Error("Worktree metadata is too large");
    const parsed = storedMetadata.parse(JSON.parse(buffer.subarray(0, bytesRead).toString("utf8")));
    return parsed.baseRef ?? parsed.baseRefName ?? null;
  } finally {
    await file.close();
  }
}

export function createComparisonBaseResolver() {
  const previous = new Map<string, string>();
  return async (
    snapshot: VcsSnapshot,
    branch: string | null,
    facts: VcsComparisonContext,
    context: VcsContext,
  ) => {
    const key = JSON.stringify([
      snapshot.binding.repositoryId,
      snapshot.binding.workingCopyId,
      branch,
    ]);
    const warning =
      facts.observedHeadRef && facts.observedHeadRef !== branch
        ? "Forge context changed; refresh the workspace."
        : facts.changeRequestError;
    try {
      const baseRef = await chooseBase(
        snapshot,
        branch,
        facts,
        warning,
        previous.get(key),
        context,
      );
      if (!warning) {
        previous.delete(key);
        if (facts.changeRequest) previous.set(key, baseRef);
        if (previous.size > 512) previous.delete(previous.keys().next().value!);
      }
      return { baseRef, error: null, warning };
    } catch (error) {
      return {
        baseRef: null,
        error: error instanceof Error ? error.message : String(error),
        warning,
      };
    }
  };
}

async function chooseBase(
  snapshot: VcsSnapshot,
  branch: string | null,
  facts: VcsComparisonContext,
  warning: string | null,
  previous: string | undefined,
  context: VcsContext,
): Promise<string> {
  const read = (args: string[]) => git(snapshot.binding.root, args, context);
  const finish = async (name: string, localFirst = false) => {
    const exact = resolveGitBaseName(snapshot.refs, name, localFirst);
    if (!exact) throw new Error(`Comparison base is unavailable: ${name}`);
    const target = snapshot.refs.find((ref) => ref.id === exact || ref.name === exact)?.targets[0];
    if (!snapshot.current || !target) throw new Error("Comparison revision is unavailable");
    await read(["merge-base", snapshot.current.id, target]);
    return exact;
  };
  if (warning && previous) return finish(previous);
  const remotes = (await read(["remote"])).trim().split("\n").filter(Boolean);
  const configured = branch
    ? (await read(["config", "--get", `branch.${branch}.remote`]).catch(() => "")).trim()
    : "";
  const remote = configured === "." ? "" : configured;
  if (!warning && facts.changeRequest) {
    const request = facts.changeRequest;
    const url = new URL(request.url);
    const repositoryPath = decodeURIComponent(url.pathname)
      .replace(/\/(?:pull|pulls)\/\d+\/?$/, "")
      .replace(/\/-\/merge_requests\/\d+\/?$/, "")
      .replace(/^\/+|\/+$/g, "");
    const matches: string[] = [];
    for (const name of remotes) {
      const location = parseGitRemoteLocation((await read(["remote", "get-url", name])).trim());
      if (
        location?.host.toLowerCase() === url.hostname.toLowerCase() &&
        location.path === repositoryPath
      )
        matches.push(name);
    }
    const selected = selectRemote(matches, remote, true);
    if (!selected) throw new Error("Cannot uniquely identify the pull request's base remote");
    return finish(`refs/remotes/${selected}/${request.baseRef}`);
  }
  const stored = await storedBase(snapshot, facts, context);
  if (stored) return finish(stored, true);
  const selected = selectRemote(remotes, remote, false);
  if (!selected) throw new Error("Cannot uniquely identify a remote for the comparison base");
  const head = (
    await read(["symbolic-ref", "--quiet", `refs/remotes/${selected}/HEAD`]).catch(() => "")
  ).trim();
  if (!head.startsWith(`refs/remotes/${selected}/`))
    throw new Error(`Remote ${selected} has no known default branch`);
  return finish(head);
}

function selectRemote(remotes: string[], configured: string, allowUnmatched: boolean) {
  if (configured && remotes.includes(configured)) return configured;
  if ((allowUnmatched || !configured) && remotes.length === 1) return remotes[0];
}
