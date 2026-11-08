import { z } from "zod";
const commit = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
export const gitRevisionComparisonData = z.object({
  version: z.literal(3),
  data: z.object({
    comparison: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("revision"), revision: commit }),
      z.object({ kind: z.literal("range"), from: commit, to: commit }),
    ]),
    ignoreWhitespace: z.boolean(),
  }),
});
export const gitComparisonDefaults = z.object({
  version: z.literal(1),
  data: z.object({
    mode: z.enum(["all", "base", "uncommitted"]),
    baseRef: z.string().nullable(),
    error: z.string().nullable(),
    warning: z.string().nullable(),
  }),
});
export const gitComparisonData = z.object({
  version: z.literal(2),
  data: z.object({
    version: z.string(),
    mode: z.enum(["combined", "committed", "all", "staged", "unstaged"]),
    base: z
      .string()
      .regex(/^[a-f0-9]{40,64}$/)
      .optional(),
    ignoreWhitespace: z.boolean(),
  }),
});

export const gitSavedComparisonSettings = z.object({
  version: z.literal(1),
  data: z
    .object({
      mode: z.enum(["all", "base", "uncommitted"]),
      baseRef: z
        .string()
        .trim()
        .min(1)
        .max(1024)
        .refine((value) => !value.startsWith("-") && !value.includes("\0"))
        .optional(),
    })
    .strict(),
});

export const gitSnapshotComparisonBase = z.object({
  version: z.literal(1),
  data: z.object({
    comparisonBase: z.object({
      baseRef: z.string().nullable(),
      error: z.string().nullable(),
      warning: z.string().nullable(),
    }),
  }),
});

export function resolveGitBaseName(
  refs: readonly { id: string }[],
  name: string,
  localFirst = false,
): string | undefined {
  const exists = (id: string) => refs.some((ref) => ref.id === id);
  if (name.startsWith("refs/")) return exists(name) ? name : undefined;
  const local = name.replace(/^origin\//, "");
  if (localFirst && exists(`refs/heads/${name}`)) return `refs/heads/${name}`;
  if (exists(`refs/remotes/origin/${local}`)) return `origin/${local}`;
  return exists(`refs/heads/${local}`) ? local : undefined;
}
