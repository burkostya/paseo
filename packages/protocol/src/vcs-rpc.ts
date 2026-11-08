import { VcsActionPreviewSchema } from "./vcs.js";
import { ParsedDiffFileSchema } from "./diff.js";
import { z } from "zod";
import type { JsonValue } from "./agent-types.js";
import {
  VcsDataSchema,
  VcsComparisonContextSchema,
  VcsWorkingCopySourceSchema,
  VcsPublicationSchema,
  VcsChangeRequestCheckoutQuerySchema,
  VcsChangeRequestCheckoutSchema,
  VcsPublicationSelectionSchema,
  VcsRemoteSchema,
  VcsChangeRequestSchema,
  VcsChangeRequestActionSchema,
  VcsBindingSchema,
  VcsLocalFilesQuerySchema,
  VcsDetectionSchema,
  VcsSnapshotSchema,
  VcsRevisionSchema,
  VcsComparisonSchema,
  VcsOperationSchema,
  VcsProblemSchema,
} from "./vcs.js";
// WebSocket JSON is structurally validated without recursive AOT generation.
const JsonWireValueSchema = z.unknown() as z.ZodType<JsonValue>;
export const VcsLocalFilesListRequestSchema = z.object({
  type: z.literal("vcs.local-files.list.request"),
  requestId: z.string(),
  binding: VcsBindingSchema,
  query: VcsLocalFilesQuerySchema,
});
export const VcsLocalFilesListResponseSchema = z.object({
  type: z.literal("vcs.local-files.list.response"),
  payload: z.object({
    requestId: z.string(),
    result: z.object({ paths: z.array(z.string()) }).nullable(),
    error: VcsProblemSchema.nullable(),
  }),
});
export const VcsProviderSchema = z.object({
  id: z.string(),
  pluginId: z.string(),
  label: z.string(),
  detectionPriority: z.number().optional(),
});
export type VcsProvider = z.infer<typeof VcsProviderSchema>;
export const VcsProvidersListRequestSchema = z.object({
  type: z.literal("vcs.providers.list.request"),
  requestId: z.string(),
});
export const VcsProvidersListResponseSchema = z.object({
  type: z.literal("vcs.providers.list.response"),
  payload: z.object({
    requestId: z.string(),
    result: z.array(VcsProviderSchema).nullable(),
    error: VcsProblemSchema.nullable(),
  }),
});
export const VcsRepositoryDetectRequestSchema = z.object({
  type: z.literal("vcs.repository.detect.request"),
  requestId: z.string(),
  workspaceId: z.string().min(1),
  providerId: z.string().min(1).optional(),
});
export const VcsRepositoryDetectResponseSchema = z.object({
  type: z.literal("vcs.repository.detect.response"),
  payload: z.object({
    requestId: z.string(),
    result: VcsDetectionSchema.nullable(),
    error: VcsProblemSchema.nullable(),
  }),
});
export const VcsSnapshotGetRequestSchema = z.object({
  type: z.literal("vcs.snapshot.get.request"),
  requestId: z.string(),
  subscribe: z.object({ subscriptionId: z.string().optional() }).optional(),
  workspaceId: z.string().min(1),
  providerId: z.string().min(1).optional(),
});
export const VcsSnapshotGetResponseSchema = z.object({
  type: z.literal("vcs.snapshot.get.response"),
  payload: z.object({
    requestId: z.string(),
    subscriptionId: z.string().optional(),
    result: VcsSnapshotSchema.nullable(),
    error: VcsProblemSchema.nullable(),
  }),
});
export const VcsSnapshotChangedSchema = z.object({
  type: z.literal("vcs.snapshot.changed"),
  payload: z.object({
    subscriptionId: z.string(),
    workspaceId: z.string(),
    result: VcsSnapshotSchema.nullable(),
    error: VcsProblemSchema.nullable(),
  }),
});
export const VcsHistoryListRequestSchema = z.object({
  type: z.literal("vcs.history.list.request"),
  requestId: z.string(),
  workspaceId: z.string().min(1),
  providerId: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(200),
  version: z.string().optional(),
  cursor: z.string().optional(),
});
export const VcsHistoryListResponseSchema = z.object({
  type: z.literal("vcs.history.list.response"),
  payload: z.object({
    requestId: z.string(),
    result: z
      .object({ revisions: z.array(VcsRevisionSchema), cursor: z.string().optional() })
      .nullable(),
    error: VcsProblemSchema.nullable(),
  }),
});
export const VcsDiffGetRequestSchema = z.object({
  type: z.literal("vcs.diff.get.request"),
  requestId: z.string(),
  workspaceId: z.string().min(1),
  providerId: z.string().min(1).optional(),
  comparison: VcsComparisonSchema,
});
export const VcsDiffGetResponseSchema = z.object({
  type: z.literal("vcs.diff.get.response"),
  payload: z.object({
    requestId: z.string(),
    result: z
      .object({ patch: z.string(), files: z.array(ParsedDiffFileSchema).optional() })
      .nullable(),
    error: VcsProblemSchema.nullable(),
  }),
});
export const VcsActionsPreviewRequestSchema = z.object({
  type: z.literal("vcs.actions.preview.request"),
  requestId: z.string(),
  workspaceId: z.string().min(1),
  providerId: z.string().min(1).optional(),
  version: z.string(),
  action: z.string().min(1),
  input: JsonWireValueSchema,
});
export const VcsActionsPreviewResponseSchema = z.object({
  type: z.literal("vcs.actions.preview.response"),
  payload: z.object({
    requestId: z.string(),
    result: VcsActionPreviewSchema.nullable(),
    error: VcsProblemSchema.nullable(),
  }),
});
export const VcsActionsExecuteRequestSchema = z.object({
  type: z.literal("vcs.actions.execute.request"),
  requestId: z.string(),
  workspaceId: z.string().min(1),
  providerId: z.string().min(1).optional(),
  operationId: z.string().min(1),
  version: z.string(),
  action: z.string().min(1),
  input: JsonWireValueSchema,
});
export const VcsActionsExecuteResponseSchema = z.object({
  type: z.literal("vcs.actions.execute.response"),
  payload: z.object({
    requestId: z.string(),
    result: VcsOperationSchema.nullable(),
    error: VcsProblemSchema.nullable(),
  }),
});
export const VcsOperationsGetRequestSchema = z.object({
  type: z.literal("vcs.operations.get.request"),
  requestId: z.string(),
  workspaceId: z.string().min(1),
  providerId: z.string().min(1),
  operationId: z.string().min(1),
});
export const VcsOperationsGetResponseSchema = z.object({
  type: z.literal("vcs.operations.get.response"),
  payload: z.object({
    requestId: z.string(),
    result: VcsOperationSchema.nullable(),
    error: VcsProblemSchema.nullable(),
  }),
});
export const VcsOperationsCancelRequestSchema = z.object({
  type: z.literal("vcs.operations.cancel.request"),
  requestId: z.string(),
  workspaceId: z.string().min(1),
  providerId: z.string().min(1),
  operationId: z.string().min(1),
});
export const VcsOperationsCancelResponseSchema = z.object({
  type: z.literal("vcs.operations.cancel.response"),
  payload: z.object({
    requestId: z.string(),
    result: VcsOperationSchema.nullable(),
    error: VcsProblemSchema.nullable(),
  }),
});
export const VcsProjectSelectionSchema = z.object({
  projectId: z.string(),
  providerId: z.string().nullable(),
});
export const VcsProjectSnapshotGetRequestSchema = z.object({
  type: z.literal("vcs.project.snapshot.get.request"),
  requestId: z.string(),
  projectId: z.string().min(1),
});
export const VcsProjectSnapshotGetResponseSchema = z.object({
  type: z.literal("vcs.project.snapshot.get.response"),
  payload: z.object({
    requestId: z.string(),
    result: z.object({ snapshot: VcsSnapshotSchema.nullable() }).nullable(),
    error: VcsProblemSchema.nullable(),
  }),
});
export const VcsProjectHistoryListRequestSchema = z.object({
  type: z.literal("vcs.project.history.list.request"),
  requestId: z.string(),
  projectId: z.string().min(1),
  providerId: z.string().min(1),
  version: z.string(),
  limit: z.number().int().min(1).max(200),
  cursor: z.string().optional(),
});
export const VcsProjectHistoryListResponseSchema = z.object({
  type: z.literal("vcs.project.history.list.response"),
  payload: z.object({
    requestId: z.string(),
    result: z
      .object({ revisions: z.array(VcsRevisionSchema), cursor: z.string().optional() })
      .nullable(),
    error: VcsProblemSchema.nullable(),
  }),
});
export const VcsProjectGetRequestSchema = z.object({
  type: z.literal("vcs.project.get.request"),
  requestId: z.string(),
  projectId: z.string().min(1),
});
export const VcsProjectSelectRequestSchema = z.object({
  type: z.literal("vcs.project.select.request"),
  requestId: z.string(),
  projectId: z.string().min(1),
  providerId: z.string().min(1),
});
export const VcsProjectGetResponseSchema = z.object({
  type: z.literal("vcs.project.get.response"),
  payload: z.object({
    requestId: z.string(),
    result: VcsProjectSelectionSchema.nullable(),
    error: VcsProblemSchema.nullable(),
  }),
});
export const VcsProjectSelectResponseSchema = z.object({
  type: z.literal("vcs.project.select.response"),
  payload: z.object({
    requestId: z.string(),
    result: VcsProjectSelectionSchema.nullable(),
    error: VcsProblemSchema.nullable(),
  }),
});
const VcsWorkspaceRequestFields = {
  requestId: z.string(),
  workspaceId: z.string().min(1),
  providerId: z.string().min(1).optional(),
};
export const VcsPublicationRemotesRequestSchema = z.object({
  type: z.literal("vcs.publication.remotes.request"),
  ...VcsWorkspaceRequestFields,
});
export const VcsPublicationResolveRequestSchema = z.object({
  type: z.literal("vcs.publication.resolve.request"),
  ...VcsWorkspaceRequestFields,
  selection: VcsPublicationSelectionSchema,
});
export const VcsPublicationPublishRequestSchema = z.object({
  type: z.literal("vcs.publication.publish.request"),
  ...VcsWorkspaceRequestFields,
  target: VcsPublicationSchema,
  operationId: z.string().min(1),
});
export const VcsChangeRequestGetRequestSchema = z.object({
  type: z.literal("vcs.change-request.get.request"),
  ...VcsWorkspaceRequestFields,
  target: VcsPublicationSchema,
});
export const VcsChangeRequestExecuteRequestSchema = z.object({
  type: z.literal("vcs.change-request.execute.request"),
  ...VcsWorkspaceRequestFields,
  target: VcsPublicationSchema,
  input: VcsChangeRequestActionSchema,
  operationId: z.string().min(1),
});
export const VcsPublicationRemotesResponseSchema = z.object({
  type: z.literal("vcs.publication.remotes.response"),
  payload: z.object({
    requestId: z.string(),
    result: z.array(VcsRemoteSchema).nullable(),
    error: VcsProblemSchema.nullable(),
  }),
});
export const VcsPublicationResolveResponseSchema = z.object({
  type: z.literal("vcs.publication.resolve.response"),
  payload: z.object({
    requestId: z.string(),
    result: VcsPublicationSchema.nullable(),
    error: VcsProblemSchema.nullable(),
  }),
});
export const VcsPublicationPublishResponseSchema = z.object({
  type: z.literal("vcs.publication.publish.response"),
  payload: z.object({
    requestId: z.string(),
    result: VcsOperationSchema.nullable(),
    error: VcsProblemSchema.nullable(),
  }),
});
export const VcsChangeRequestGetResponseSchema = z.object({
  type: z.literal("vcs.change-request.get.response"),
  payload: z.object({
    requestId: z.string(),
    result: z.object({ forge: z.string(), status: VcsChangeRequestSchema.nullable() }).nullable(),
    error: VcsProblemSchema.nullable(),
  }),
});
export const VcsChangeRequestExecuteResponseSchema = z.object({
  type: z.literal("vcs.change-request.execute.response"),
  payload: z.object({
    requestId: z.string(),
    result: VcsOperationSchema.nullable(),
    error: VcsProblemSchema.nullable(),
  }),
});
export const VcsChangeRequestResolveCheckoutRequestSchema = z.object({
  type: z.literal("vcs.change-request.resolve-checkout.request"),
  requestId: z.string(),
  query: VcsChangeRequestCheckoutQuerySchema,
});
export const VcsChangeRequestResolveCheckoutResponseSchema = z.object({
  type: z.literal("vcs.change-request.resolve-checkout.response"),
  payload: z.object({
    requestId: z.string(),
    result: VcsChangeRequestCheckoutSchema.nullable(),
    error: VcsProblemSchema.nullable(),
  }),
});
export const VcsProjectWorkingCopyResolveSourceRequestSchema = z.object({
  type: z.literal("vcs.project.working-copy.resolve-source.request"),
  requestId: z.string(),
  projectId: z.string().min(1),
  providerId: z.string().min(1),
  input: VcsDataSchema,
});
export const VcsProjectWorkingCopyResolveSourceResponseSchema = z.object({
  type: z.literal("vcs.project.working-copy.resolve-source.response"),
  payload: z.object({
    requestId: z.string(),
    result: VcsWorkingCopySourceSchema.nullable(),
    error: VcsProblemSchema.nullable(),
  }),
});
export const VcsComparisonContextRequestSchema = z.object({
  type: z.literal("vcs.comparison.context.request"),
  requestId: z.string(),
  binding: VcsBindingSchema,
});
export const VcsComparisonContextResponseSchema = z.object({
  type: z.literal("vcs.comparison.context.response"),
  payload: z.object({
    requestId: z.string(),
    result: VcsComparisonContextSchema.nullable(),
    error: VcsProblemSchema.nullable(),
  }),
});
export const VcsComparisonTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("project"), projectId: z.string().min(1) }),
  z.object({ kind: z.literal("workspace"), workspaceId: z.string().min(1) }),
]);
export const VcsComparisonSettingsSchema = z.object({
  providerId: z.string(),
  selection: VcsDataSchema.nullable(),
  inherited: VcsDataSchema.nullable(),
  effective: VcsDataSchema.nullable(),
});
export const VcsComparisonGetRequestSchema = z.object({
  type: z.literal("vcs.comparison.get.request"),
  requestId: z.string(),
  target: VcsComparisonTargetSchema,
  providerId: z.string().min(1),
});
export const VcsComparisonSetRequestSchema = z.object({
  type: z.literal("vcs.comparison.set.request"),
  requestId: z.string(),
  target: VcsComparisonTargetSchema,
  providerId: z.string().min(1),
  value: VcsDataSchema.nullable(),
});
export const VcsComparisonGetResponseSchema = z.object({
  type: z.literal("vcs.comparison.get.response"),
  payload: z.object({
    requestId: z.string(),
    result: VcsComparisonSettingsSchema.nullable(),
    error: VcsProblemSchema.nullable(),
  }),
});
export const VcsComparisonSetResponseSchema = z.object({
  type: z.literal("vcs.comparison.set.response"),
  payload: z.object({
    requestId: z.string(),
    result: VcsComparisonSettingsSchema.nullable(),
    error: VcsProblemSchema.nullable(),
  }),
});
export type VcsComparisonTarget = z.infer<typeof VcsComparisonTargetSchema>;
export type VcsComparisonSettings = z.infer<typeof VcsComparisonSettingsSchema>;
export const VcsInboundMessageSchema = z.discriminatedUnion("type", [
  VcsComparisonContextRequestSchema,
  VcsComparisonGetRequestSchema,
  VcsComparisonSetRequestSchema,
  VcsProjectWorkingCopyResolveSourceRequestSchema,
  VcsChangeRequestResolveCheckoutRequestSchema,
  VcsProjectSnapshotGetRequestSchema,
  VcsProjectHistoryListRequestSchema,
  VcsPublicationRemotesRequestSchema,
  VcsPublicationResolveRequestSchema,
  VcsPublicationPublishRequestSchema,
  VcsChangeRequestGetRequestSchema,
  VcsChangeRequestExecuteRequestSchema,
  VcsLocalFilesListRequestSchema,
  VcsProjectGetRequestSchema,
  VcsProjectSelectRequestSchema,
  VcsProvidersListRequestSchema,
  VcsRepositoryDetectRequestSchema,
  VcsSnapshotGetRequestSchema,
  VcsHistoryListRequestSchema,
  VcsDiffGetRequestSchema,
  VcsActionsPreviewRequestSchema,
  VcsActionsExecuteRequestSchema,
  VcsOperationsGetRequestSchema,
  VcsOperationsCancelRequestSchema,
]);
export const VcsOutboundMessageSchema = z.discriminatedUnion("type", [
  VcsComparisonContextResponseSchema,
  VcsComparisonGetResponseSchema,
  VcsComparisonSetResponseSchema,
  VcsProjectWorkingCopyResolveSourceResponseSchema,
  VcsChangeRequestResolveCheckoutResponseSchema,
  VcsProjectSnapshotGetResponseSchema,
  VcsProjectHistoryListResponseSchema,
  VcsSnapshotChangedSchema,
  VcsPublicationRemotesResponseSchema,
  VcsPublicationResolveResponseSchema,
  VcsPublicationPublishResponseSchema,
  VcsChangeRequestGetResponseSchema,
  VcsChangeRequestExecuteResponseSchema,
  VcsLocalFilesListResponseSchema,
  VcsProjectGetResponseSchema,
  VcsProjectSelectResponseSchema,
  VcsProvidersListResponseSchema,
  VcsRepositoryDetectResponseSchema,
  VcsSnapshotGetResponseSchema,
  VcsHistoryListResponseSchema,
  VcsDiffGetResponseSchema,
  VcsActionsPreviewResponseSchema,
  VcsActionsExecuteResponseSchema,
  VcsOperationsGetResponseSchema,
  VcsOperationsCancelResponseSchema,
]);
export type VcsInboundMessage = z.infer<typeof VcsInboundMessageSchema>;
export type VcsOutboundMessage = z.infer<typeof VcsOutboundMessageSchema>;
