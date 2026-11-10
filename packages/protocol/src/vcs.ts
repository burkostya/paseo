import { z } from "zod";
import type { JsonValue } from "./agent-types.js";
// See docs/protocol-validation.md: JSON has already crossed the wire; avoid recursive AOT codegen.
const JsonWireValueSchema = z.unknown() as z.ZodType<JsonValue>;
/** Provider data stays opaque to the host, but is versioned for durable recovery. */
export const VcsDataSchema = z.object({
  version: z.number().int().positive(),
  data: JsonWireValueSchema,
});
export const VcsBindingSchema = z.object({
  providerId: z.string(),
  repositoryId: z.string(),
  workingCopyId: z.string(),
  root: z.string(),
  cwd: z.string(),
});
export const VcsRevisionSchema = z.object({
  id: z.string(),
  changeId: z.string().optional(),
  parents: z.array(z.string()),
  description: z.string(),
  author: z.object({ name: z.string(), email: z.string() }),
  timestamp: z.string(),
  conflict: z.boolean(),
});
export const VcsRefSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.string(),
  targets: z.array(z.string()),
  remote: z.string().optional(),
  tracked: z.boolean().optional(),
  publishable: z.boolean().optional(),
});
export const VcsFileSchema = z.object({
  path: z.string(),
  previousPath: z.string().optional(),
  status: z.string(),
  conflict: z.boolean(),
});
export const VcsActionPreviewSchema = z.object({
  revisions: z.array(VcsRevisionSchema),
  files: z.array(z.string()),
  refs: z.array(VcsRefSchema),
});
export type VcsActionPreview = z.infer<typeof VcsActionPreviewSchema>;
export const VcsActionSchema = z.object({
  id: z.string(),
  enabled: z.boolean(),
  reason: z.string().optional(),
  preview: z.boolean().optional(),
});
export const VcsComparisonSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("working-copy"), data: VcsDataSchema.optional() }),
  z.object({ kind: z.literal("revision"), revision: z.string() }),
  z.object({ kind: z.literal("range"), from: z.string(), to: z.string() }),
]);
export const VcsComparisonResolveInputSchema = z.object({
  mode: z.enum(["task", "working-copy", "change-request"]),
  baseRef: z.string().min(1).max(1024).optional(),
});
export const VcsResolvedComparisonSchema = z.object({
  comparison: VcsComparisonSchema,
  description: z.string(),
  baseRef: z.string().nullable(),
  baseRevision: z.string().nullable(),
  mergeBaseRevision: z.string().nullable(),
  headRevision: z.string().nullable(),
  sourceUrl: z.string().nullable(),
});
export type VcsComparisonResolveInput = z.infer<typeof VcsComparisonResolveInputSchema>;
export type VcsResolvedComparison = z.infer<typeof VcsResolvedComparisonSchema>;
export const VcsSnapshotSchema = z.object({
  binding: VcsBindingSchema,
  version: z.string(),
  workingComparison: VcsComparisonSchema.optional(),
  comparisons: z.array(z.object({ id: z.string(), comparison: VcsComparisonSchema })).optional(),
  data: VcsDataSchema.optional(),
  current: VcsRevisionSchema.nullable(),
  files: z.array(VcsFileSchema),
  refs: z.array(VcsRefSchema),
  capabilities: z.array(z.string()),
  actions: z.array(VcsActionSchema),
  state: z.enum(["ready", "stale"]),
});
export const VcsWorkingCopySourceSchema = z.object({
  revision: z.string().min(1),
  data: VcsDataSchema.optional(),
});
export const VcsWorkingCopyCreateSchema = z.object({
  root: z.string().min(1),
  name: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/),
  revision: z.string().min(1),
  data: VcsDataSchema.optional(),
});
export const VcsPublicationSelectionSchema = z.object({
  remote: z.string().min(1),
  headRef: z.string().min(1),
  baseRef: z.string().min(1),
  data: VcsDataSchema.optional(),
});
export const VcsPublicationSchema = z.object({
  remote: z.string(),
  repositoryUrl: z.string(),
  headRef: z.string(),
  headRevision: z.string(),
  baseRef: z.string(),
  data: VcsDataSchema.optional(),
  selection: VcsPublicationSelectionSchema.optional(),
});
export const VcsRemoteSchema = z.object({
  name: z.string(),
  fetchUrl: z.string(),
  pushUrls: z.array(z.string()),
});
export const VcsProblemSchema = z.object({
  code: z.enum([
    "unavailable",
    "unsupported-version",
    "outdated",
    "conflict",
    "stale",
    "remote",
    "provider",
    "cancelled",
  ]),
  message: z.string(),
  recoveryAction: z.string().optional(),
});
export const VcsWorkingCopyRecordSchema = z.object({
  binding: VcsBindingSchema,
  owned: z.boolean(),
  source: VcsBindingSchema.optional(),
  data: VcsDataSchema.optional(),
  recovery: VcsDataSchema.optional(),
  recoveryError: VcsProblemSchema.optional(),
  state: z.enum(["present", "prepared", "removed", "restoring", "restored"]).optional(),
});
/** Host facts only. Providers choose comparison semantics. */
export const VcsComparisonContextSchema = z.object({
  workingCopy: VcsWorkingCopyRecordSchema.nullable(),
  changeRequest: z.object({ url: z.string(), baseRef: z.string(), headRef: z.string() }).nullable(),
  changeRequestError: z.string().nullable(),
  observedHeadRef: z.string().nullable(),
});
export type VcsComparisonContext = z.infer<typeof VcsComparisonContextSchema>;

export const VcsOperationSchema = z.object({
  id: z.string(),
  status: z.enum(["pending", "running", "succeeded", "failed", "unknown"]),
  result: JsonWireValueSchema.optional(),
  error: VcsProblemSchema.optional(),
});
export const VcsDetectionSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("absent") }),
  z.object({ status: z.literal("available"), binding: VcsBindingSchema }),
  z.object({ status: z.literal("unavailable"), error: VcsProblemSchema }),
]);
export const VcsLocalFilesQuerySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("tracked") }),
  z.object({ kind: z.literal("ignored"), patterns: z.array(z.string()).max(10000) }),
]);
export const VcsRecoveryOperationSchema = z.enum([
  "prepare-removal",
  "remove",
  "restore",
  "release",
]);
export const VcsObservationPlanSchema = z.object({
  fingerprint: z.string(),
  roots: z.array(
    z.object({
      path: z.string().min(1),
      scope: z.enum(["working-copy", "repository"]),
      kind: z.enum(["files", "metadata"]).optional(),
      ignore: z.array(z.string()).optional(),
    }),
  ),
});
export const VcsRequestSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("comparison.resolve"),
    binding: VcsBindingSchema,
    input: VcsComparisonResolveInputSchema,
    settings: VcsDataSchema.nullable(),
  }),
  z.object({
    kind: z.literal("actions.preview"),
    binding: VcsBindingSchema,
    version: z.string(),
    action: z.string(),
    input: JsonWireValueSchema,
  }),
  z.object({
    kind: z.literal("comparison-settings.validate"),
    binding: VcsBindingSchema,
    value: VcsDataSchema.nullable(),
  }),
  z.object({
    kind: z.literal("working-copy.resolve-source"),
    binding: VcsBindingSchema,
    input: VcsDataSchema,
  }),
  z.object({ kind: z.literal("detect"), cwd: z.string() }),
  z.object({
    kind: z.literal("publication.archive-safety"),
    binding: VcsBindingSchema,
    target: VcsPublicationSchema,
  }),
  z.object({ kind: z.literal("publication.remotes"), binding: VcsBindingSchema }),
  z.object({
    kind: z.literal("publication.resolve"),
    binding: VcsBindingSchema,
    selection: VcsPublicationSelectionSchema,
  }),
  z.object({
    kind: z.literal("publication.verify"),
    binding: VcsBindingSchema,
    target: VcsPublicationSchema,
  }),
  z.object({
    kind: z.literal("publication.publish"),
    binding: VcsBindingSchema,
    target: VcsPublicationSchema,
    operationId: z.string().min(1),
  }),
  z.object({ kind: z.literal("snapshot"), binding: VcsBindingSchema }),
  z.object({ kind: z.literal("observation"), binding: VcsBindingSchema }),
  z.object({
    kind: z.literal("local-files"),
    binding: VcsBindingSchema,
    query: VcsLocalFilesQuerySchema,
  }),
  z.object({
    kind: z.literal("history"),
    binding: VcsBindingSchema,
    limit: z.number().int().min(1).max(200),
    version: z.string().optional(),
    cursor: z.string().optional(),
  }),
  z.object({ kind: z.literal("diff"), binding: VcsBindingSchema, comparison: VcsComparisonSchema }),
  z.object({
    kind: z.literal("execute"),
    binding: VcsBindingSchema,
    operationId: z.string().min(1),
    version: z.string(),
    action: z.string(),
    input: JsonWireValueSchema,
  }),
  z.object({
    kind: z.literal("working-copy.rollback"),
    binding: VcsBindingSchema,
    record: VcsWorkingCopyRecordSchema,
  }),
  z.object({ kind: z.literal("working-copy.inspect"), record: VcsWorkingCopyRecordSchema }),
  z.object({
    kind: z.literal("working-copy.recovery"),
    operation: VcsRecoveryOperationSchema,
    record: VcsWorkingCopyRecordSchema,
    operationId: z.string().min(1),
  }),
  z.object({ kind: z.literal("operation"), operationId: z.string() }),
  z.object({ kind: z.literal("cancel"), operationId: z.string() }),
]);
export const VcsResponseSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("comparison.resolved"), resolved: VcsResolvedComparisonSchema }),
  z.object({ kind: z.literal("actions.preview"), preview: VcsActionPreviewSchema }),
  z.object({ kind: z.literal("comparison-settings"), value: VcsDataSchema.nullable() }),
  z.object({ kind: z.literal("working-copy.source"), source: VcsWorkingCopySourceSchema }),
  z.object({ kind: z.literal("publication.archive-safety"), safe: z.boolean() }),
  z.object({ kind: z.literal("publication.remotes"), remotes: z.array(VcsRemoteSchema) }),
  z.object({ kind: z.literal("publication"), publication: VcsPublicationSchema }),
  z.object({ kind: z.literal("publication.verify") }),
  z.object({ kind: z.literal("working-copy.rollback") }),
  z.object({ kind: z.literal("working-copy.inspect") }),
  z.object({ kind: z.literal("error"), error: VcsProblemSchema }),
  z.object({ kind: z.literal("detect"), detection: VcsDetectionSchema }),
  z.object({ kind: z.literal("snapshot"), snapshot: VcsSnapshotSchema }),
  z.object({ kind: z.literal("observation"), plan: VcsObservationPlanSchema.nullable() }),
  z.object({
    kind: z.literal("history"),
    revisions: z.array(VcsRevisionSchema),
    cursor: z.string().optional(),
  }),
  z.object({ kind: z.literal("diff"), patch: z.string() }),
  z.object({ kind: z.literal("local-files"), paths: z.array(z.string()) }),
  z.object({ kind: z.literal("operation"), operation: VcsOperationSchema }),
]);
export const VcsChangeRequestSchema = z.object({
  number: z.number().int().positive().optional(),
  url: z.string(),
  title: z.string(),
  state: z.string(),
  projectPath: z.string().optional(),
  repoOwner: z.string().optional(),
  repoName: z.string().optional(),
  baseRefName: z.string(),
  headRefName: z.string(),
  isMerged: z.boolean(),
  isDraft: z.boolean().optional(),
  mergeable: z.string(),
  checksStatus: z.string(),
  reviewDecision: z.string().nullable(),
  checks: z.array(
    z.object({
      name: z.string(),
      status: z.string(),
      url: z.string().nullable(),
      workflow: z.string().optional(),
      duration: z.string().optional(),
      checkRunId: z.number().optional(),
      workflowRunId: z.number().optional(),
      traits: z.array(z.string()).optional(),
    }),
  ),
  forgeSpecific: JsonWireValueSchema.optional(),
});
const VcsMergeMethodSchema = z.enum(["merge", "squash", "rebase"]);
export const VcsChangeRequestActionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("create"),
    title: z.string().min(1),
    body: z.string(),
    publish: z.boolean(),
  }),
  z.object({
    action: z.literal("merge"),
    number: z.number().int().positive(),
    url: z.string(),
    mergeMethod: VcsMergeMethodSchema,
  }),
  z.object({
    action: z.literal("enable-auto-merge"),
    number: z.number().int().positive(),
    url: z.string(),
    mergeMethod: VcsMergeMethodSchema,
  }),
  z.object({
    action: z.literal("disable-auto-merge"),
    number: z.number().int().positive(),
    url: z.string(),
  }),
]);
export const VcsPublicationResultSchema = z.object({
  publication: VcsPublicationSchema,
  stage: z.enum(["ready", "published", "created", "updated"]),
  changeRequest: z.object({ number: z.number().int().positive(), url: z.string() }).optional(),
});

export type VcsObservationPlan = z.infer<typeof VcsObservationPlanSchema>;
export type VcsBinding = z.infer<typeof VcsBindingSchema>;
export type VcsRevision = z.infer<typeof VcsRevisionSchema>;
export type VcsRef = z.infer<typeof VcsRefSchema>;
export type VcsSnapshot = z.infer<typeof VcsSnapshotSchema>;
export type VcsComparison = z.infer<typeof VcsComparisonSchema>;
export type VcsWorkingCopyRecord = z.infer<typeof VcsWorkingCopyRecordSchema>;
export type VcsPublication = z.infer<typeof VcsPublicationSchema>;
export type VcsProblem = z.infer<typeof VcsProblemSchema>;
export type VcsOperation = z.infer<typeof VcsOperationSchema>;
export type VcsDetection = z.infer<typeof VcsDetectionSchema>;
export type VcsRequest = z.infer<typeof VcsRequestSchema>;
export type VcsResponse = z.infer<typeof VcsResponseSchema>;
export type VcsWorkingCopyCreate = z.infer<typeof VcsWorkingCopyCreateSchema>;
export type VcsLocalFilesQuery = z.infer<typeof VcsLocalFilesQuerySchema>;
export type VcsRecoveryOperation = z.infer<typeof VcsRecoveryOperationSchema>;
export type VcsPublicationSelection = z.infer<typeof VcsPublicationSelectionSchema>;
export type VcsRemote = z.infer<typeof VcsRemoteSchema>;
export type VcsChangeRequestAction = z.infer<typeof VcsChangeRequestActionSchema>;
export type VcsPublicationResult = z.infer<typeof VcsPublicationResultSchema>;
export type VcsChangeRequest = z.infer<typeof VcsChangeRequestSchema>;
export type VcsData = z.infer<typeof VcsDataSchema>;

/** Forge-owned checkout facts. VCS providers own fetching and working-copy changes. */
export const VcsChangeRequestCheckoutQuerySchema = z.object({
  cwd: z.string().min(1),
  repositoryUrl: z.string().min(1),
  forge: z.string().min(1),
  number: z.number().int().positive(),
});
export const VcsChangeRequestCheckoutSchema = z.object({
  forge: z.string(),
  changeRequestNumber: z.number().int().positive(),
  headRef: z.string().min(1),
  baseRefName: z.string().min(1),
  checkoutRefs: z
    .array(z.object({ remoteName: z.string().optional(), remoteRef: z.string().min(1) }))
    .min(1),
  localBranchName: z.string().optional(),
  headRepositoryOwner: z.string().optional(),
  pushRemoteUrl: z.string().optional(),
  trackOriginHead: z.boolean().optional(),
});
export type VcsChangeRequestCheckoutQuery = z.infer<typeof VcsChangeRequestCheckoutQuerySchema>;
export type VcsChangeRequestCheckout = z.infer<typeof VcsChangeRequestCheckoutSchema>;

export type VcsWorkingCopySource = z.infer<typeof VcsWorkingCopySourceSchema>;
