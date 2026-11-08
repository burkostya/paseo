import { z } from "zod";
import { defineRpc, VcsBindingSchema, VcsChangeRequestCheckoutSchema } from "@getpaseo/plugin";
import { oid, refName } from "./actions.js";
const fetchSource = z.object({ url: z.string().min(1), ref: refName }).strict();
export const sourceSelection = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("branch"), ref: refName }).strict(),
  z
    .object({
      kind: z.literal("change-request"),
      forge: z.string().min(1),
      number: z.number().int().positive(),
    })
    .strict(),
]);
export const sourceInput = z.object({ version: z.literal(1), data: sourceSelection }).strict();
export const preparedSource = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("branch"), ref: refName, fetch: fetchSource.optional() }).strict(),
  z
    .object({
      kind: z.literal("change-request"),
      repositoryUrl: z.string().min(1),
      target: VcsChangeRequestCheckoutSchema,
      fetch: fetchSource,
    })
    .strict(),
]);
export const workingCopyOptions = z.discriminatedUnion("version", [
  z
    .object({ version: z.literal(1), data: z.object({ branch: refName.max(200) }).strict() })
    .strict(),
  z
    .object({
      version: z.literal(2),
      data: z.object({ branch: refName.max(200).optional(), source: preparedSource }).strict(),
    })
    .strict(),
]);
export const resolvedSource = z.object({ revision: oid, data: workingCopyOptions });
export const resolveSourceRpc = defineRpc({
  name: "source.resolve",
  input: z.object({ binding: VcsBindingSchema, selection: sourceSelection }),
  output: resolvedSource,
});
export type SourceSelection = z.infer<typeof sourceSelection>;
export type PreparedSource = z.infer<typeof preparedSource>;
export type ResolvedSource = z.infer<typeof resolvedSource>;
