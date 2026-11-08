import { z } from "zod";
export const oid = z.string().regex(/^[a-f0-9]{40,64}$/);
export const refName = z
  .string()
  .min(1)
  .regex(/^[a-zA-Z0-9._/-]+$/)
  .refine((value) => !value.startsWith("-") && !value.startsWith("/") && !value.includes(".."));
const file = z
  .string()
  .min(1)
  .refine(
    (value) =>
      !value.startsWith("/") &&
      !value.includes("\\") &&
      !value.split("/").includes("..") &&
      !value.split("/").includes(".git") &&
      !value.includes("\0"),
  );
const files = z.array(file).min(1).max(10000);
export const actionInput = z.discriminatedUnion("action", [
  z.object({ action: z.literal("stage"), files }),
  z.object({ action: z.literal("unstage"), files }),
  z.object({ action: z.literal("discard"), files }),
  z.object({ action: z.literal("restore"), files, revision: oid }),
  z.object({ action: z.literal("commit"), message: z.string().trim().min(1), all: z.boolean() }),
  z.object({ action: z.literal("fetch"), remote: refName }),
  z.object({ action: z.literal("push"), remote: refName, name: refName }),
  z.object({ action: z.literal("pull"), remote: refName, name: refName }),
  z.object({ action: z.literal("pull-and-push"), remote: refName, name: refName }),
  z.object({ action: z.literal("branch-create"), name: refName, revision: oid }),
  z.object({ action: z.literal("branch-switch"), name: refName }),
  z.object({ action: z.literal("branch-delete"), name: refName }),
  z.object({ action: z.literal("merge"), revision: oid }),
]);
export const actionIds = actionInput.options.map((option) => option.shape.action.value);
export type GitAction = z.infer<typeof actionInput>["action"];
export const snapshotData = z.object({
  version: z.literal(1),
  data: z.object({ branch: z.string().nullable() }),
});
