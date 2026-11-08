import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { VcsDataSchema } from "@getpaseo/plugin";
import { oid, refName } from "../shared/actions.js";
import { git } from "./commands.js";
import type { VcsContext } from "@getpaseo/plugin/server/vcs";
export const metadata = z
  .object({
    version: z.literal(2),
    baseRefName: z.string(),
    baseRef: z.string(),
    changeRequestLookupTarget: z.object({
      headRef: refName,
      localBranchName: refName,
      changeRequestNumber: z.number().optional(),
      headRepositoryOwner: z.string().optional(),
    }),
  })
  .catchall(VcsDataSchema.shape.data);
export const copyRecordData = z.object({
  version: z.union([z.literal(1), z.literal(2)]),
  data: z.object({
    branch: refName,
    revision: oid,
    metadata: metadata.optional(),
    remote: refName.optional(),
  }),
});
export async function writeCopyMetadata(
  root: string,
  data: z.infer<typeof metadata>,
  context: VcsContext,
) {
  const directory = (await git(root, ["rev-parse", "--absolute-git-dir"], context)).trim();
  const target = path.join(directory, "paseo");
  await mkdir(target, { recursive: true });
  // COMPAT(gitCopyMetadata): v0.15.2; remove when all Git comparison/forge reads use provider snapshots.
  // The durable provider record owns these facts; this is the existing readers' projection.
  await writeFile(path.join(target, "worktree.json"), JSON.stringify(data));
}
