import { listGitIgnoredFiles as gitIgnoredFiles } from "./git-files.js";
import {
  VcsActionPreviewSchema,
  VcsResolvedComparisonSchema,
  VcsDataSchema,
  VcsWorkingCopySourceSchema,
  VcsWorkingCopyCreateSchema,
  VcsWorkingCopyRecordSchema,
  VcsPublicationSchema,
} from "../vcs.js";
import type { JsonValue } from "@getpaseo/protocol/agent-types";
import type {
  VcsPublication,
  VcsPublicationSelection,
  VcsRemote,
  VcsWorkingCopySource,
  VcsData,
  VcsWorkingCopyCreate,
  VcsWorkingCopyRecord,
  VcsBinding,
  VcsLocalFilesQuery,
  VcsComparison,
  VcsDetection,
  VcsRequest,
  VcsResponse,
  VcsRevision,
  VcsSnapshot,
  VcsObservationPlan,
} from "../vcs.js";

export interface VcsContext {
  signal: AbortSignal;
}
export interface VcsExecutionContext extends VcsContext {
  snapshot: VcsSnapshot;
}
export interface VcsRecoveryContext extends VcsContext {
  operationId: string;
}
export interface VcsWorkingCopyRecovery {
  inspect(record: VcsWorkingCopyRecord, context: VcsContext): Promise<void>;
  prepareRemoval(
    record: VcsWorkingCopyRecord,
    context: VcsRecoveryContext,
  ): Promise<VcsWorkingCopyRecord>;
  remove(record: VcsWorkingCopyRecord, context: VcsRecoveryContext): Promise<VcsWorkingCopyRecord>;
  restore(record: VcsWorkingCopyRecord, context: VcsRecoveryContext): Promise<VcsWorkingCopyRecord>;
  release(record: VcsWorkingCopyRecord, context: VcsRecoveryContext): Promise<VcsWorkingCopyRecord>;
}
export interface VcsPublicationProvider {
  canArchive?(
    binding: VcsBinding,
    target: VcsPublication,
    snapshot: VcsSnapshot,
    context: VcsContext,
  ): Promise<boolean>;
  remotes(binding: VcsBinding, context: VcsContext): Promise<VcsRemote[]>;
  resolve(
    binding: VcsBinding,
    selection: VcsPublicationSelection,
    snapshot: VcsSnapshot,
    context: VcsContext,
  ): Promise<VcsPublication>;
  publish(
    binding: VcsBinding,
    target: VcsPublication,
    snapshot: VcsSnapshot,
    context: VcsContext,
  ): Promise<VcsPublication>;
  verify(binding: VcsBinding, target: VcsPublication, context: VcsContext): Promise<void>;
}
export interface VcsHostApi {
  comparisonContext(binding: VcsBinding): Promise<import("../vcs.js").VcsComparisonContext>;
  resolveChangeRequest(
    query: import("../vcs.js").VcsChangeRequestCheckoutQuery,
  ): Promise<import("../vcs.js").VcsChangeRequestCheckout>;
  listLocalFiles(binding: VcsBinding, query: VcsLocalFilesQuery): Promise<string[]>;
}
export interface VcsProviderRegistration {
  resolveComparison?(
    binding: VcsBinding,
    input: import("../vcs.js").VcsComparisonResolveInput,
    settings: VcsData | null,
    context: VcsContext,
  ): Promise<import("../vcs.js").VcsResolvedComparison>;
  validateComparisonSettings?(
    binding: VcsBinding,
    value: VcsData,
    context: VcsContext,
  ): Promise<VcsData>;
  id: string;
  label: string;
  detectionPriority?: number;
  localFiles?(
    binding: VcsBinding,
    query: VcsLocalFilesQuery,
    context: VcsContext,
  ): Promise<string[]>;
  publication?: VcsPublicationProvider;
  workingCopies?: {
    recovery?: VcsWorkingCopyRecovery;
    resolveSource?(
      binding: VcsBinding,
      input: VcsData,
      context: VcsContext,
    ): Promise<VcsWorkingCopySource>;
    create(
      binding: VcsBinding,
      input: VcsWorkingCopyCreate,
      context: VcsContext,
    ): Promise<VcsWorkingCopyRecord>;
    /** Only for a failed creation, before handing the copy to its caller. Never archive with this. */
    rollback(binding: VcsBinding, record: VcsWorkingCopyRecord, context: VcsContext): Promise<void>;
  };
  detect(cwd: string, context: VcsContext): Promise<VcsDetection>;
  snapshot(binding: VcsBinding, context: VcsContext): Promise<VcsSnapshot>;
  /** Read metadata without snapshotting. The host owns watches and repository-wide invalidation. */
  observation?(binding: VcsBinding, context: VcsContext): Promise<VcsObservationPlan>;
  history?(
    binding: VcsBinding,
    input: { limit: number; cursor?: string; version?: string },
    context: VcsContext,
  ): Promise<{ revisions: VcsRevision[]; cursor?: string }>;
  diff?(binding: VcsBinding, comparison: VcsComparison, context: VcsContext): Promise<string>;
  previewAction?(
    binding: VcsBinding,
    action: string,
    input: JsonValue,
    context: VcsExecutionContext,
  ): Promise<import("../vcs.js").VcsActionPreview>;
  execute?(
    binding: VcsBinding,
    action: string,
    input: JsonValue,
    context: VcsExecutionContext,
  ): Promise<JsonValue>;
}

export { VcsError, VcsUnknownOutcomeError } from "./vcs-error.js";
import { VcsError } from "./vcs-error.js";
import { createVcsOperationExecutor } from "./vcs-operations.js";
export { createVcsOperationExecutor, type VcsOperationContext } from "./vcs-operations.js";

type PublicationRequest = Extract<
  VcsRequest,
  {
    kind:
      | "publication.publish"
      | "publication.remotes"
      | "publication.verify"
      | "publication.resolve"
      | "publication.archive-safety";
  }
>;
function isPublicationRequest(request: VcsRequest): request is PublicationRequest {
  return request.kind.startsWith("publication.");
}

function validateOptionalMethod(value: unknown, message: string): void {
  if (value !== undefined && typeof value !== "function") throw new Error(message);
}

/** One instance per registration, shared by in-process and subprocess installations. */
export function createVcsHandler(provider: VcsProviderRegistration) {
  if (!/^[a-z][a-z0-9-]*$/.test(provider.id) || !provider.label.trim()) {
    throw new Error(`Invalid VCS provider: ${provider.id}`);
  }
  for (const method of ["detect", "snapshot"] as const) {
    if (typeof provider[method] !== "function")
      throw new Error(`VCS provider ${provider.id} must implement ${method}()`);
  }
  for (const method of [
    "previewAction",
    "execute",
    "history",
    "diff",
    "observation",
    "localFiles",
    "validateComparisonSettings",
    "resolveComparison",
  ] as const) {
    validateOptionalMethod(
      provider[method],
      `VCS provider ${provider.id} must implement ${method}()`,
    );
  }
  if (provider.workingCopies) {
    validateOptionalMethod(
      provider.workingCopies.resolveSource,
      `VCS provider ${provider.id} must implement workingCopies.resolveSource()`,
    );
    for (const method of ["create", "rollback"] as const) {
      if (typeof provider.workingCopies[method] !== "function")
        throw new Error(`VCS provider ${provider.id} must implement workingCopies.${method}()`);
    }
  }
  if (provider.workingCopies?.recovery) {
    for (const method of ["inspect", "prepareRemoval", "remove", "restore", "release"] as const) {
      if (typeof provider.workingCopies.recovery[method] !== "function")
        throw new Error(
          `VCS provider ${provider.id} must implement workingCopies.recovery.${method}()`,
        );
    }
  }
  if (provider.publication) {
    validateOptionalMethod(
      provider.publication.canArchive,
      `VCS provider ${provider.id} must implement publication.canArchive()`,
    );
    for (const method of ["remotes", "resolve", "publish", "verify"] as const)
      if (typeof provider.publication[method] !== "function")
        throw new Error(`VCS provider ${provider.id} must implement publication.${method}()`);
  }
  const queues = new Map<string, Promise<unknown>>();
  const lifetime = new AbortController();
  const context = { signal: lifetime.signal };
  function serial<T>(repository: string, run: () => Promise<T>): Promise<T> {
    const result = (queues.get(repository) ?? Promise.resolve())
      .catch(() => {})
      .then(() => {
        lifetime.signal.throwIfAborted();
        return run();
      });
    queues.set(repository, result);
    void result
      .finally(() => {
        if (queues.get(repository) === result) queues.delete(repository);
      })
      .catch(() => {});
    return result;
  }
  const operations = createVcsOperationExecutor({ signal: lifetime.signal, serial });
  async function verify(binding: VcsBinding, ctx: VcsContext = context): Promise<void> {
    if (binding.providerId !== provider.id)
      throw new Error("VCS provider does not own this binding");
    const detected = await provider.detect(binding.cwd, ctx);
    if (detected.status === "unavailable") throw new VcsError(detected.error);
    if (
      detected.status !== "available" ||
      detected.binding.repositoryId !== binding.repositoryId ||
      detected.binding.workingCopyId !== binding.workingCopyId ||
      detected.binding.root !== binding.root
    ) {
      throw new VcsError({
        code: "outdated",
        message: "Working copy binding changed; refresh the workspace",
      });
    }
  }
  async function snapshot(binding: VcsBinding, ctx: VcsContext): Promise<VcsSnapshot> {
    const value = await provider.snapshot(binding, ctx);
    const capabilities = provider.publication
      ? [...new Set([...value.capabilities, "publication"])]
      : value.capabilities;
    if (!provider.workingCopies) return { ...value, capabilities };
    return {
      ...value,
      capabilities: [
        ...capabilities,
        "working-copies",
        ...(provider.workingCopies.resolveSource ? ["working-copy-sources"] : []),
      ],
      actions: [
        ...value.actions,
        { id: "working-copy.create", enabled: value.state === "ready" && value.current !== null },
      ],
    };
  }
  function startOperation(
    request: Extract<
      VcsRequest,
      { kind: "execute" | "working-copy.recovery" | "publication.publish" }
    >,
    repository: string,
    run: (ctx: VcsContext, started: () => void) => Promise<JsonValue | undefined>,
  ): VcsResponse {
    return {
      kind: "operation",
      operation: operations.start(
        request.operationId,
        JSON.stringify(request),
        repository,
        async ({ signal, started }) => {
          if ("binding" in request) await verify(request.binding, { signal });
          return run({ signal }, started);
        },
      ),
    };
  }
  async function handleRecovery(
    request: Extract<VcsRequest, { kind: "working-copy.inspect" | "working-copy.recovery" }>,
  ): Promise<VcsResponse> {
    const recovery = provider.workingCopies?.recovery;
    if (!recovery || !request.record.owned || request.record.binding.providerId !== provider.id)
      throw new VcsError({
        code: "unavailable",
        message: "Working copy recovery is unavailable",
      });
    if (request.kind === "working-copy.inspect") {
      await serial(request.record.binding.repositoryId, () =>
        recovery.inspect(request.record, context),
      );
      return { kind: "working-copy.inspect" };
    }
    return startOperation(request, request.record.binding.repositoryId, async (ctx, started) => {
      if (request.operation !== "restore") await verify(request.record.binding);
      started();
      const methods = {
        "prepare-removal": recovery.prepareRemoval,
        remove: recovery.remove,
        restore: recovery.restore,
        release: recovery.release,
      };
      return VcsWorkingCopyRecordSchema.parse(
        await methods[request.operation](request.record, {
          ...ctx,
          operationId: request.operationId,
        }),
      );
    });
  }
  async function handlePublication(
    request: Extract<
      VcsRequest,
      {
        kind:
          | "publication.publish"
          | "publication.remotes"
          | "publication.verify"
          | "publication.resolve"
          | "publication.archive-safety";
      }
    >,
  ): Promise<VcsResponse> {
    const publication = provider.publication;
    if (!publication)
      throw new VcsError({ code: "unavailable", message: "Provider does not support publication" });
    if (request.kind === "publication.publish")
      return startOperation(request, request.binding.repositoryId, async (ctx, started) => {
        const current = await snapshot(request.binding, ctx);
        const resolved = await publication.resolve(request.binding, request.target, current, ctx);
        if (
          JSON.stringify(VcsPublicationSchema.parse(resolved)) !==
          JSON.stringify(VcsPublicationSchema.parse(request.target))
        )
          throw new VcsError({
            code: "outdated",
            message: "Publication target changed; review it again",
          });
        started();
        return VcsPublicationSchema.parse(
          await publication.publish(request.binding, request.target, current, ctx),
        );
      });
    if (request.kind === "publication.remotes")
      return serial(request.binding.repositoryId, async () => ({
        kind: "publication.remotes",
        remotes: await publication.remotes(request.binding, context),
      }));
    if (request.kind === "publication.archive-safety")
      return serial(request.binding.repositoryId, async () => {
        const current = await snapshot(request.binding, context);
        const resolved = await publication.resolve(
          request.binding,
          request.target,
          current,
          context,
        );
        const unchanged =
          JSON.stringify(VcsPublicationSchema.parse(resolved)) ===
          JSON.stringify(VcsPublicationSchema.parse(request.target));
        return {
          kind: "publication.archive-safety",
          safe:
            unchanged &&
            publication.canArchive !== undefined &&
            (await publication.canArchive(request.binding, request.target, current, context)),
        };
      });
    if (request.kind === "publication.verify")
      return serial(request.binding.repositoryId, async () => {
        const current = await snapshot(request.binding, context);
        const resolved = await publication.resolve(
          request.binding,
          request.target,
          current,
          context,
        );
        if (
          JSON.stringify(VcsPublicationSchema.parse(resolved)) !==
          JSON.stringify(VcsPublicationSchema.parse(request.target))
        )
          throw new VcsError({
            code: "outdated",
            message: "Publication target changed; review it again",
          });
        await publication.verify(request.binding, request.target, context);
        return { kind: "publication.verify" };
      });
    if (request.kind === "publication.resolve")
      return serial(request.binding.repositoryId, async () => ({
        kind: "publication",
        publication: await publication.resolve(
          request.binding,
          request.selection,
          await snapshot(request.binding, context),
          context,
        ),
      }));
    throw new Error("Invalid publication request");
  }
  async function previewAction(
    request: Extract<VcsRequest, { kind: "actions.preview" }>,
    binding: VcsBinding,
  ): Promise<VcsResponse> {
    if (!provider.previewAction)
      throw new VcsError({
        code: "unavailable",
        message: "Provider does not support action previews",
      });
    const current = await snapshot(binding, context);
    if (current.version !== request.version)
      throw new VcsError({
        code: "outdated",
        message: "Repository changed; review the operation again",
      });
    const action = current.actions.find((item) => item.id === request.action);
    if (!action?.enabled)
      throw new VcsError({
        code: "unavailable",
        message: action?.reason ?? "Action is unavailable",
      });
    return {
      kind: "actions.preview",
      preview: VcsActionPreviewSchema.parse(
        await provider.previewAction(binding, request.action, request.input, {
          ...context,
          snapshot: current,
        }),
      ),
    };
  }
  async function handle(request: VcsRequest): Promise<VcsResponse> {
    lifetime.signal.throwIfAborted();
    if (request.kind === "detect")
      return { kind: "detect", detection: await provider.detect(request.cwd, context) };
    if (request.kind === "operation" || request.kind === "cancel") {
      return {
        kind: "operation",
        operation:
          request.kind === "cancel"
            ? operations.cancel(request.operationId)
            : operations.get(request.operationId),
      };
    }
    if (
      request.kind === "execute" ||
      request.kind === "working-copy.recovery" ||
      request.kind === "publication.publish"
    ) {
      const existing = operations.replay(request.operationId, JSON.stringify(request));
      if (existing) return { kind: "operation", operation: existing };
    }
    if (request.kind === "working-copy.inspect" || request.kind === "working-copy.recovery")
      return handleRecovery(request);
    await verify(request.binding);
    const binding = request.binding;
    if (isPublicationRequest(request)) return handlePublication(request);
    if (request.kind === "working-copy.rollback") {
      const workingCopies = provider.workingCopies;
      if (!workingCopies || !request.record.owned)
        throw new Error("Working copy rollback is unavailable");
      await verify(request.record.binding);
      if (
        request.record.binding.repositoryId !== binding.repositoryId ||
        request.record.binding.root === binding.root
      )
        throw new Error("Cannot roll back this working copy");
      await serial(binding.repositoryId, () =>
        workingCopies.rollback(binding, request.record, context),
      );
      return { kind: "working-copy.rollback" };
    }
    if (request.kind === "execute") {
      return startOperation(request, binding.repositoryId, async (ctx, started) => {
        const current = await snapshot(binding, ctx);
        if (current.version !== request.version)
          throw new VcsError({
            code: "outdated",
            message: "Repository changed; review the operation again",
          });
        const action = current.actions.find((candidate) => candidate.id === request.action);
        if (!action?.enabled)
          throw new VcsError({
            code: provider.execute ? "provider" : "unavailable",
            message: action?.reason ?? "Action is unavailable",
          });
        started();
        if (request.action === "working-copy.create") {
          if (!provider.workingCopies) throw new Error("Working copy creation is unavailable");
          return VcsWorkingCopyRecordSchema.parse(
            await provider.workingCopies.create(
              binding,
              VcsWorkingCopyCreateSchema.parse(request.input),
              ctx,
            ),
          );
        }
        if (!provider.execute)
          throw new VcsError({ code: "unavailable", message: "Provider does not support actions" });
        return provider.execute(binding, request.action, request.input, {
          ...ctx,
          snapshot: current,
        });
      });
    }
    return serial(binding.repositoryId, async () => {
      if (request.kind === "actions.preview") return previewAction(request, binding);
      if (request.kind === "comparison.resolve") {
        if (!provider.resolveComparison)
          throw new VcsError({
            code: "unavailable",
            message: "Provider cannot resolve comparisons",
          });
        return {
          kind: "comparison.resolved",
          resolved: VcsResolvedComparisonSchema.parse(
            await provider.resolveComparison(binding, request.input, request.settings, context),
          ),
        };
      }
      if (request.kind === "comparison-settings.validate") {
        if (!provider.validateComparisonSettings)
          throw new VcsError({
            code: "unavailable",
            message: "Provider does not support comparison settings",
          });
        return {
          kind: "comparison-settings",
          value:
            request.value === null
              ? null
              : VcsDataSchema.parse(
                  await provider.validateComparisonSettings(binding, request.value, context),
                ),
        };
      }

      if (request.kind === "working-copy.resolve-source") {
        const resolveSource = provider.workingCopies?.resolveSource;
        if (!resolveSource)
          throw new VcsError({
            code: "unavailable",
            message: "Provider does not support working-copy source preparation",
          });
        return {
          kind: "working-copy.source",
          source: VcsWorkingCopySourceSchema.parse(
            await resolveSource(binding, request.input, context),
          ),
        };
      }
      if (request.kind === "observation")
        return {
          kind: "observation",
          plan: (await provider.observation?.(binding, context)) ?? null,
        };
      if (request.kind === "snapshot")
        return { kind: "snapshot", snapshot: await snapshot(binding, context) };
      if (request.kind === "local-files") {
        if (!provider.localFiles)
          throw new VcsError({
            code: "unavailable",
            message: "Provider does not support local file queries",
          });
        return {
          kind: "local-files",
          paths: await provider.localFiles(binding, request.query, context),
        };
      }
      if (request.kind === "history") {
        if (!provider.history)
          throw new VcsError({ code: "unavailable", message: "Provider does not support history" });
        return { kind: "history", ...(await provider.history(binding, request, context)) };
      }
      if (!provider.diff)
        throw new VcsError({ code: "unavailable", message: "Provider does not support diffs" });
      return { kind: "diff", patch: await provider.diff(binding, request.comparison, context) };
    });
  }
  return { handle, dispose: () => lifetime.abort() };
}

export async function listGitIgnoredFiles(
  options: Parameters<typeof gitIgnoredFiles>[0],
): Promise<string[]> {
  try {
    return await gitIgnoredFiles(options);
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT" &&
      "path" in error &&
      error.path === "git"
    )
      throw new VcsError({
        code: "unavailable",
        message: "Git executable is required to select ignored local files",
      });
    throw error;
  }
}

export { listUnpreservedFiles } from "./working-copy-files.js";
export { createGitPublication } from "./git-publication.js";

export { fingerprintVcsPaths } from "./vcs-observation.js";
export { gitObservationIgnoredDirectories } from "./git-files.js";

export { parseGitRemoteLocation } from "@getpaseo/protocol/git-remote";
