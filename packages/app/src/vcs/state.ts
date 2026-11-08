import { z } from "zod";
import { publicationDraftSchema } from "./publication-state";
import { workingCopyDraftSchema } from "./working-copy-model";
import type { JsonValue } from "@getpaseo/protocol/agent-types";
import {
  VcsPublicationSchema,
  VcsChangeRequestActionSchema,
  VcsRevisionSchema,
  VcsRefSchema,
} from "@getpaseo/protocol/vcs";

export const vcsOperationRequestSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("action"),
    action: z.string(),
    version: z.string(),
    input: z.unknown() as z.ZodType<JsonValue>,
  }),
  z.object({
    kind: z.literal("publication"),
    target: VcsPublicationSchema,
    input: VcsChangeRequestActionSchema,
  }),
]);
export const vcsPaneStateSchema = z.object({
  providerId: z.string().optional(),
  consumedActionRequestId: z.string().optional(),
  consumedComparisonRequestId: z.string().optional(),
  consumedViewRequestId: z.string().optional(),
  publication: publicationDraftSchema.optional(),
  workingCopy: workingCopyDraftSchema.optional(),
  view: z.string(),
  comparisonId: z.string().optional(),
  baseRef: z.string().optional(),
  range: z.object({ from: z.string(), to: z.string() }).optional(),
  selection: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("workspace") }),
    z.object({ kind: z.literal("revision"), revision: VcsRevisionSchema }),
    z.object({ kind: z.literal("ref"), ref: VcsRefSchema, revision: VcsRevisionSchema.nullable() }),
  ]),
  operation: z
    .object({ providerId: z.string(), id: z.string(), request: vcsOperationRequestSchema })
    .optional(),
});
export type VcsPaneState = z.infer<typeof vcsPaneStateSchema>;
export const vcsComparisonRequestSchema = z.object({
  requestId: z.string().min(1),
  providerId: z.string().min(1),
  selection: vcsPaneStateSchema.shape.selection,
  comparisonId: z.string().optional(),
  baseRef: z.string().optional(),
  range: vcsPaneStateSchema.shape.range,
});
export type VcsComparisonRequest = z.infer<typeof vcsComparisonRequestSchema>;
export const vcsViewRequestSchema = z.object({
  requestId: z.string().trim().min(1),
  providerId: z.string().trim().min(1),
  view: z.string().trim().min(1),
});
export type VcsViewRequest = z.infer<typeof vcsViewRequestSchema>;
export type VcsOperationRequest = z.infer<typeof vcsOperationRequestSchema>;
export const defaultVcsPaneState: VcsPaneState = {
  view: "changes",
  selection: { kind: "workspace" },
};
