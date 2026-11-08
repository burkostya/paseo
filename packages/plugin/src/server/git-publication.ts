import type { VcsBinding, VcsPublication, VcsSnapshot } from "../vcs.js";
import type { VcsContext, VcsPublicationProvider } from "./vcs.js";
import { VcsError } from "./vcs-error.js";

type Git = (binding: VcsBinding, args: string[], context: VcsContext) => Promise<string>;
/** Git-backed providers share remote configuration and remote SHA verification, not checkout semantics. */
export function createGitPublication(options: {
  git: Git;
  head(snapshot: VcsSnapshot, name: string): string;
  canArchive?(
    binding: VcsBinding,
    target: VcsPublication,
    snapshot: VcsSnapshot,
    context: VcsContext,
  ): Promise<boolean>;
  push(
    binding: VcsBinding,
    target: VcsPublication,
    snapshot: VcsSnapshot,
    context: VcsContext,
  ): Promise<void>;
}): VcsPublicationProvider {
  const git = options.git;
  async function remotes(binding: VcsBinding, context: VcsContext) {
    const names = (await git(binding, ["remote"], context)).trim().split("\n").filter(Boolean);
    const result = [];
    for (const name of names)
      result.push({
        name,
        fetchUrl: (await git(binding, ["remote", "get-url", "--", name], context)).trim(),
        pushUrls: (
          await git(binding, ["remote", "get-url", "--push", "--all", "--", name], context)
        )
          .trim()
          .split("\n")
          .filter(Boolean),
      });
    return result;
  }
  return {
    remotes,
    canArchive: options.canArchive,
    async resolve(binding, selection, snapshot, context) {
      if (snapshot.state !== "ready")
        throw new VcsError({
          code: "stale",
          message: "Update the stale workspace before publication",
          recoveryAction: "update-stale",
        });
      for (const name of [selection.headRef, selection.baseRef])
        await git(binding, ["check-ref-format", `refs/heads/${name}`], context);
      const remote = (await remotes(binding, context)).find(
        (item) => item.name === selection.remote,
      );
      if (!remote) throw new VcsError({ code: "remote", message: "Select an existing remote" });
      if (remote.pushUrls.length !== 1)
        throw new VcsError({
          code: "remote",
          message: "Publication requires a remote with exactly one push URL",
        });
      return {
        remote: remote.name,
        repositoryUrl: remote.pushUrls[0]!,
        headRef: selection.headRef,
        baseRef: selection.baseRef,
        headRevision: options.head(snapshot, selection.headRef),
      };
    },
    async verify(binding, target, context) {
      try {
        const output = await git(
          binding,
          [
            "ls-remote",
            "--exit-code",
            "--refs",
            "--",
            target.repositoryUrl,
            `refs/heads/${target.headRef}`,
          ],
          context,
        );
        const matching = output
          .trim()
          .split("\n")
          .map((line) => line.split(/\s+/))
          .filter(([, ref]) => ref === `refs/heads/${target.headRef}`);
        if (matching.length !== 1 || matching[0]![0] !== target.headRevision)
          throw new VcsError({
            code: "outdated",
            message:
              "The remote ref does not match the selected revision; publish and review again",
          });
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === 2)
          throw new VcsError({
            code: "outdated",
            message: "The selected remote ref no longer exists; refresh before retrying",
          });
        if (error instanceof VcsError) throw error;
        throw new VcsError({
          code: "remote",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    },
    async publish(binding, target, snapshot, context) {
      try {
        await options.push(binding, target, snapshot, context);
        await this.verify(binding, target, context);
        return target;
      } catch (error) {
        if (error instanceof VcsError) throw error;
        throw new VcsError({
          code: "remote",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    },
  };
}
