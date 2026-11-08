import { z } from "zod";

const commit = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
export const jjComparisonData = z.object({
  version: z.literal(1),
  data: z.object({
    operation: z.string().regex(/^[a-f0-9]+$/),
    revision: commit,
    base: commit.optional(),
    ignoreWhitespace: z.boolean(),
  }),
});

export const jjSavedComparisonSettings = z.object({
  version: z.literal(1),
  data: z.discriminatedUnion("mode", [
    z.object({ mode: z.literal("change") }).strict(),
    z.object({ mode: z.literal("base"), baseRef: z.string().min(1).max(2048) }).strict(),
  ]),
});
