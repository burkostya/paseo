import { z } from "zod";
import type { VcsPublicationProvider } from "@getpaseo/plugin/server/vcs";
import { refName } from "../shared/actions.js";
import { git } from "./commands.js";

const source = z.object({ version: z.literal(1), data: z.object({ localBranch: refName }) });

/** Preserve the local source when a PR checkout publishes under a different remote name. */
export function withPushMapping(publication: VcsPublicationProvider): VcsPublicationProvider {
  return {
    ...publication,
    async resolve(binding, selection, snapshot, context) {
      const localBranch = selection.data
        ? source.parse(selection.data).data.localBranch
        : selection.headRef;
      const target = await publication.resolve(
        binding,
        { ...selection, headRef: localBranch },
        snapshot,
        context,
      );
      const configured = async (key: string) =>
        (
          await git(binding.root, ["config", "--get", key], context).catch((error) => {
            if (error instanceof Error && "code" in error && error.code === 1) return "";
            throw error;
          })
        ).trim();
      const pushRemote = await configured(`branch.${localBranch}.pushRemote`);
      if (pushRemote !== target.remote) return target;
      const mapping = await configured(`remote.${pushRemote}.push`);
      if (!mapping.startsWith("HEAD:refs/heads/")) return target;
      const headRef = refName.parse(mapping.slice("HEAD:refs/heads/".length));
      return {
        ...target,
        headRef,
        selection: { remote: selection.remote, headRef: localBranch, baseRef: selection.baseRef },
        data: { version: 1, data: { localBranch } },
      };
    },
  };
}
