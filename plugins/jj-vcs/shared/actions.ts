import { z } from "zod";
export const revision = z.string().regex(/^[0-9a-f]{40,64}$/);
export const name = z
  .string()
  .min(1)
  .refine((value) => !value.startsWith("-") && !value.includes("\0"));
const files = z
  .array(
    z
      .string()
      .min(1)
      .refine(
        (value) =>
          !value.startsWith("/") && !value.split(/[\\/]/).includes("..") && !value.includes("\0"),
      ),
  )
  .min(1);
export const actionInput = z.discriminatedUnion("action", [
  z.object({ action: z.literal("new"), parents: z.array(revision).min(1) }),
  z.object({ action: z.literal("edit"), revision }),
  z.object({ action: z.literal("describe"), revision, message: z.string() }),
  z.object({ action: z.literal("abandon"), revision }),
  z.object({ action: z.literal("rebase"), revision, destination: revision }),
  z.object({ action: z.literal("squash"), revision, destination: revision, files }),
  z.object({ action: z.literal("split"), revision, files, message: z.string() }),
  z.object({ action: z.literal("restore"), revision, files }),
  z.object({ action: z.literal("bookmark-create"), name, revision }),
  z.object({ action: z.literal("bookmark-set"), name, revision }),
  z.object({ action: z.literal("bookmark-delete"), name }),
  z.object({ action: z.literal("bookmark-track"), name, remote: name }),
  z.object({ action: z.literal("fetch"), remote: name }),
  z.object({ action: z.literal("push"), name, remote: name }),
  z.object({ action: z.literal("update-stale") }),
]);
export const rewritingActions = new Set<JjAction>([
  "abandon",
  "restore",
  "bookmark-delete",
  "bookmark-set",
  "rebase",
  "squash",
  "split",
  "describe",
]);
export const actionIds = actionInput.options.map((option) => option.shape.action.value);
export type JjAction = z.infer<typeof actionInput>["action"];
