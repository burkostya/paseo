import {
  createComparisonSettings,
  type PaseoVcsComparisonSettings,
} from "./comparison-settings.js";
import type { DaemonClient } from "../daemon-client.js";
import type {
  VcsPublication,
  VcsPublicationSelection,
  VcsRemote,
  VcsChangeRequest,
  VcsChangeRequestAction,
  VcsComparison,
  VcsDetection,
  VcsOperation,
  VcsProblem,
  VcsRevision,
  VcsSnapshot,
} from "@getpaseo/protocol/vcs";
import type {
  VcsInboundMessage,
  VcsOutboundMessage,
  VcsProvider,
} from "@getpaseo/protocol/vcs-rpc";
import type { JsonValue } from "@getpaseo/protocol/agent-types";

export type VcsClientRequest = {
  [K in VcsInboundMessage["type"]]: Omit<Extract<VcsInboundMessage, { type: K }>, "requestId">;
}[VcsInboundMessage["type"]];
export type VcsResponseType<K extends VcsInboundMessage["type"]> = K extends `${infer Name}.request`
  ? `${Name}.response`
  : never;
export type VcsResult<K extends VcsInboundMessage["type"]> = NonNullable<
  Extract<VcsOutboundMessage, { type: VcsResponseType<K> }>["payload"]["result"]
>;

export class VcsRequestError extends Error {
  constructor(readonly problem: VcsProblem) {
    super(problem.message);
    this.name = "VcsRequestError";
  }
}
export interface PaseoWorkspaceVcs {
  readonly comparison: PaseoVcsComparisonSettings & {
    resolve(
      providerId: string,
      input: import("@getpaseo/protocol/vcs").VcsComparisonResolveInput,
    ): Promise<import("@getpaseo/protocol/vcs").VcsResolvedComparison>;
  };
  readonly publication: {
    remotes(providerId?: string): Promise<VcsRemote[]>;
    resolve(selection: VcsPublicationSelection, providerId?: string): Promise<VcsPublication>;
    publish(
      options: { operationId: string; target: VcsPublication },
      providerId?: string,
    ): Promise<VcsOperation>;
    status(
      target: VcsPublication,
      providerId?: string,
    ): Promise<{ forge: string; status: VcsChangeRequest | null }>;
    execute(
      options: { operationId: string; target: VcsPublication; input: VcsChangeRequestAction },
      providerId?: string,
    ): Promise<VcsOperation>;
  };
  providers(): Promise<VcsProvider[]>;
  detect(providerId?: string): Promise<VcsDetection>;
  snapshot(providerId?: string): Promise<VcsSnapshot>;
  observeSnapshot(
    providerId?: string,
    options?: { signal?: AbortSignal },
  ): ReturnType<DaemonClient["observeVcsSnapshot"]>;
  history(
    providerId?: string,
    options?: { limit?: number; cursor?: string; version?: string },
  ): Promise<{ revisions: VcsRevision[]; cursor?: string }>;
  diff(
    providerId: string | undefined,
    comparison: VcsComparison,
  ): Promise<{ patch: string; files?: import("@getpaseo/protocol/diff").ParsedDiffFile[] }>;
  preview(
    providerId: string | undefined,
    options: { version: string; action: string; input: JsonValue },
  ): Promise<import("@getpaseo/protocol/vcs").VcsActionPreview>;
  execute(
    providerId: string | undefined,
    options: { operationId: string; version: string; action: string; input: JsonValue },
  ): Promise<VcsOperation>;
  operation(providerId: string, operationId: string): Promise<VcsOperation>;
  cancel(providerId: string, operationId: string): Promise<VcsOperation>;
}
export function createWorkspaceVcs(
  client: DaemonClient,
  workspaceId: string,
  own: <T extends { release(): Promise<void> }>(create: () => T) => T,
): PaseoWorkspaceVcs {
  return {
    comparison: {
      ...createComparisonSettings(client, { kind: "workspace", workspaceId }),
      resolve: (providerId, input) =>
        client.requestVcs({
          type: "vcs.comparison.resolve.request",
          workspaceId,
          providerId,
          input,
        }),
    },
    publication: {
      remotes: (providerId) =>
        client.requestVcs({ type: "vcs.publication.remotes.request", workspaceId, providerId }),
      resolve: (selection, providerId) =>
        client.requestVcs({
          type: "vcs.publication.resolve.request",
          workspaceId,
          providerId,
          selection,
        }),
      publish: (options, providerId) =>
        client.requestVcs({
          type: "vcs.publication.publish.request",
          workspaceId,
          providerId,
          ...options,
        }),
      status: (target, providerId) =>
        client.requestVcs({
          type: "vcs.change-request.get.request",
          workspaceId,
          providerId,
          target,
        }),
      execute: (options, providerId) =>
        client.requestVcs({
          type: "vcs.change-request.execute.request",
          workspaceId,
          providerId,
          ...options,
        }),
    },
    providers: () => client.requestVcs({ type: "vcs.providers.list.request" }),
    detect: (providerId) =>
      client.requestVcs({ type: "vcs.repository.detect.request", workspaceId, providerId }),
    observeSnapshot: (providerId, options) =>
      own(() => client.observeVcsSnapshot(workspaceId, providerId, options)),
    snapshot: (providerId) =>
      client.requestVcs({ type: "vcs.snapshot.get.request", workspaceId, providerId }),
    history: (providerId, options) =>
      client.requestVcs({
        type: "vcs.history.list.request",
        workspaceId,
        providerId,
        limit: options?.limit ?? 50,
        cursor: options?.cursor,
        version: options?.version,
      }),
    diff: (providerId, comparison) =>
      client.requestVcs({ type: "vcs.diff.get.request", workspaceId, providerId, comparison }),
    preview: (providerId, options) =>
      client.requestVcs({
        type: "vcs.actions.preview.request",
        workspaceId,
        providerId,
        ...options,
      }),
    execute: (providerId, options) =>
      client.requestVcs({
        type: "vcs.actions.execute.request",
        workspaceId,
        providerId,
        ...options,
      }),
    operation: (providerId, operationId) =>
      client.requestVcs({
        type: "vcs.operations.get.request",
        workspaceId,
        providerId,
        operationId,
      }),
    cancel: (providerId, operationId) =>
      client.requestVcs({
        type: "vcs.operations.cancel.request",
        workspaceId,
        providerId,
        operationId,
      }),
  };
}
