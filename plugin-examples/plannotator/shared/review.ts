import { defineRpc, defineSettings, VcsResolvedComparisonSchema } from "@getpaseo/plugin";
import { z } from "zod";

export const sourceSelection = z.object({
  mode: z.enum(["task", "working-copy", "change-request"]),
  baseRef: z.string().min(1).optional(),
});
export type SourceSelection = z.infer<typeof sourceSelection>;
export const guideDocument = z.object({
  title: z.string().min(1),
  intent: z.string(),
  sections: z
    .array(
      z.object({
        title: z.string().min(1),
        overview: z.string(),
        diffs: z.array(z.object({ file: z.string().min(1), summary: z.string() })),
      }),
    )
    .min(1),
});
export type GuideDocument = z.infer<typeof guideDocument>;
export const fileEntry = z.object({
  path: z.string(),
  oldPath: z.string().nullable(),
  kind: z.enum(["added", "deleted", "renamed", "modified", "binary"]),
  fingerprint: z.string(),
});
export type FileEntry = z.infer<typeof fileEntry>;
export const draft = z
  .object({
    codeAnnotations: z.array(z.json()),
    descriptionAnnotations: z.array(z.json()).optional(),
    commentAnnotations: z.array(z.json()).optional(),
    viewedFiles: z.array(z.string()).optional(),
    autoViewSuppressed: z.array(z.string()).optional(),
    draftGeneration: z.number().int().optional(),
    ts: z.number(),
  })
  .passthrough();
export type Draft = z.infer<typeof draft>;
export const guide = z.object({
  id: z.string(),
  source: z.enum(["paseo-agent", "plannotator"]),
  requestId: z.string().nullable(),
  status: z.enum(["pending", "ready", "cancelled", "failed"]),
  engineId: z.string().nullable(),
  document: guideDocument.nullable(),
  reviewed: z.array(z.boolean()),
  uncovered: z.array(z.string()),
  error: z.string().nullable(),
});
export type Guide = z.infer<typeof guide>;
export const revision = z.object({
  id: z.string(),
  createdAt: z.string(),
  selection: sourceSelection,
  resolved: VcsResolvedComparisonSchema.nullable(),
  patchHash: z.string().nullable(),
  patchPath: z.string().nullable(),
  files: z.array(fileEntry),
  draft: draft.nullable(),
  guides: z.array(guide),
});
export type Revision = z.infer<typeof revision>;
export const delivery = z.object({
  id: z.string(),
  revisionId: z.string(),
  agentId: z.string(),
  text: z.string(),
  status: z.enum(["pending", "sending", "sent", "failed", "unknown"]),
  error: z.string().nullable(),
});
export type Delivery = z.infer<typeof delivery>;
export const reviewState = z.object({
  version: z.literal(2),
  id: z.string(),
  agentId: z.string(),
  workspaceId: z.string(),
  workspaceName: z.string(),
  agentName: z.string(),
  cwd: z.string(),
  revisionId: z.string(),
  liveRevisionId: z.string().nullable(),
  status: z.enum(["paused", "starting", "reviewing", "sending", "sent", "cancelled", "failed"]),
  url: z.string().nullable(),
  error: z.string().nullable(),
  revisions: z.array(revision),
  deliveries: z.array(delivery),
});
export type ReviewState = z.infer<typeof reviewState>;
export const prepared = z.object({
  workspaceName: z.string(),
  agentName: z.string(),
  cwd: z.string(),
  agentBusy: z.boolean(),
  refs: z.array(z.object({ value: z.string(), label: z.string() })),
  resolved: VcsResolvedComparisonSchema.nullable(),
  error: z.string().nullable(),
});
export type Prepared = z.infer<typeof prepared>;
export const preferences = defineSettings({
  id: "review",
  scope: "host",
  version: 1,
  schema: z.object({ autoViewedDisabledAcknowledged: z.boolean().default(false) }),
  migrate: () => ({ autoViewedDisabledAcknowledged: false }),
});
export const target = z.object({ agentId: z.string(), workspaceId: z.string() });
export type Target = z.infer<typeof target>;
export const operation = target.extend({ reviewId: z.string(), revisionId: z.string() });
export type Operation = z.infer<typeof operation>;
export const prepareReview = defineRpc({
  name: "review.prepare",
  input: target.extend({ selection: sourceSelection }),
  output: prepared,
});
export const startReview = defineRpc({
  name: "review.start",
  input: target.extend({ selection: sourceSelection }),
  output: reviewState,
});
export const getReview = defineRpc({
  name: "review.get",
  input: target,
  output: reviewState.nullable(),
});
export const openReview = defineRpc({
  name: "review.open",
  input: operation.extend({ viewRevisionId: z.string().optional() }),
  output: reviewState,
});
export const updateReview = defineRpc({
  name: "review.update",
  input: operation.extend({ selection: sourceSelection }),
  output: reviewState,
});
export const cancelReview = defineRpc({
  name: "review.cancel",
  input: operation,
  output: reviewState,
});
export const retryReview = defineRpc({
  name: "review.retry",
  input: operation.extend({ deliveryId: z.string() }),
  output: reviewState,
});
export const requestGuide = defineRpc({
  name: "guide.request",
  input: operation,
  output: reviewState,
});
export const cancelGuide = defineRpc({
  name: "guide.cancel",
  input: operation.extend({ requestId: z.string() }),
  output: reviewState,
});
