import { setTimeout as delay } from "node:timers/promises";
import {
  createVcsOperationExecutor,
  VcsError,
  VcsUnknownOutcomeError,
  type VcsOperationContext,
} from "@getpaseo/plugin/server/vcs";
import {
  VcsPublicationSchema,
  VcsPublicationResultSchema,
  type VcsPublication,
  type VcsChangeRequestAction,
  type VcsBinding,
  type VcsOperation,
} from "@getpaseo/protocol/vcs";
import { createForgeResolver, type ForgeResolver } from "../services/forge-resolver.js";
import type { ForgeService, CurrentPullRequestStatus } from "../services/forge-service.js";
import type { WorkspaceVcsService, VcsPlugins } from "./workspace-vcs-service.js";

export interface WorkspacePublicationStatus {
  workspaceId: string;
  binding: VcsBinding;
  target: VcsPublication;
  forge: string;
  status: CurrentPullRequestStatus | null;
}
function remoteError(error: unknown): VcsError {
  if (error instanceof VcsError) return error;
  const detail =
    error instanceof Error && "stderr" in error && typeof error.stderr === "string"
      ? error.stderr.trim()
      : "";
  return new VcsError({
    code: "remote",
    message: `${error instanceof Error ? error.message : String(error)}${detail ? `: ${detail}` : ""}`,
  });
}
export class WorkspacePublicationService {
  private readonly listeners = new Set<(event: WorkspacePublicationStatus) => void>();
  subscribe(listener: (event: WorkspacePublicationStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly operations = createVcsOperationExecutor({
    serial: (repository, run) => {
      const result = (this.queues.get(repository) ?? Promise.resolve()).catch(() => {}).then(run);
      this.queues.set(repository, result);
      void result
        .finally(() => {
          if (this.queues.get(repository) === result) this.queues.delete(repository);
        })
        .catch(() => {});
      return result;
    },
  });
  private readonly forge: ForgeResolver;
  constructor(
    private readonly deps: { vcs: WorkspaceVcsService; plugins: VcsPlugins; forge?: ForgeResolver },
  ) {
    this.forge = deps.forge ?? createForgeResolver();
  }
  private key(providerId: string, operationId: string) {
    return JSON.stringify([providerId, operationId]);
  }
  lookup(providerId: string, operationId: string): VcsOperation | undefined {
    const key = this.key(providerId, operationId);
    return this.operations.has(key) ? { ...this.operations.get(key), id: operationId } : undefined;
  }
  cancel(providerId: string, operationId: string): VcsOperation | undefined {
    const key = this.key(providerId, operationId);
    return this.operations.has(key)
      ? { ...this.operations.cancel(key), id: operationId }
      : undefined;
  }
  assertUnreserved(providerId: string, operationId: string): void {
    if (this.lookup(providerId, operationId))
      throw new Error("Operation ID was already used for another request");
  }
  async validate(binding: VcsBinding, target: VcsPublication): Promise<void> {
    const response = await this.deps.plugins.invokeVcs(binding.providerId, {
      kind: "publication.resolve",
      binding,
      selection: target,
    });
    if (response.kind !== "publication") throw new Error("Invalid publication response");
    if (
      JSON.stringify(VcsPublicationSchema.parse(response.publication)) !==
      JSON.stringify(VcsPublicationSchema.parse(target))
    )
      throw new VcsError({
        code: "outdated",
        message: "Publication target changed; review it again",
      });
  }
  private async resolveForge(target: VcsPublication) {
    const forge = await this.forge.resolveRepository(target.repositoryUrl);
    if (!forge)
      throw new VcsError({
        code: "unavailable",
        message: "No supported forge is configured for the selected remote",
      });
    return forge;
  }
  async status(
    workspaceId: string,
    binding: VcsBinding,
    target: VcsPublication,
    options?: { force: boolean; reason?: string },
  ) {
    await this.validate(binding, target);
    const { forge, service } = await this.resolveForge(target);
    const lookup = { cwd: binding.cwd, headRef: target.headRef, headSha: target.headRevision };
    let status: CurrentPullRequestStatus | null;
    try {
      status = options?.force
        ? await service.getCurrentPullRequestStatus({
            ...lookup,
            force: true,
            reason: options.reason ?? "vcs-auto-archive-validation",
          })
        : await service.getCurrentPullRequestStatus(lookup);
    } catch (error) {
      throw remoteError(error);
    }
    for (const listener of this.listeners)
      listener({ workspaceId, binding, target, forge, status });
    return { forge, status };
  }
  async canArchive(
    workspaceId: string,
    providerId: string,
    target: VcsPublication,
  ): Promise<boolean> {
    return this.deps.vcs.withWorkspace(workspaceId, providerId, async ({ binding, workspace }) => {
      if (workspace.archivedAt || !workspace.vcsWorkingCopy?.owned) return false;
      await this.deps.vcs.assertNoPendingOperations(workspace.projectId);
      const response = await this.deps.plugins.invokeVcs(providerId, {
        kind: "publication.archive-safety",
        binding,
        target,
      });
      if (response.kind !== "publication.archive-safety")
        throw new Error("Invalid publication safety response");
      return response.safe;
    });
  }
  /** Called under the project lock; the operation re-enters it after submission returns. */
  async execute(input: {
    workspaceId: string;
    binding: VcsBinding;
    operationId: string;
    target: VcsPublication;
    input: VcsChangeRequestAction;
  }): Promise<VcsOperation> {
    const { binding, operationId, target } = input;
    const key = this.key(binding.providerId, operationId);
    const fingerprint = JSON.stringify(input);
    const replay = this.operations.replay(key, fingerprint);
    if (replay) return { ...replay, id: operationId };
    const previous = await this.deps.plugins.invokeVcs(binding.providerId, {
      kind: "operation",
      operationId,
    });
    if (previous.kind !== "operation" || previous.operation.status !== "unknown")
      throw new Error("Operation ID was already used for another request");
    const operation = this.operations.start(
      key,
      fingerprint,
      binding.repositoryId,
      async (context) => {
        const current = await this.activeBinding(input.workspaceId, binding.providerId);
        return this.perform(input.workspaceId, current, target, input.input, operationId, context);
      },
    );
    return { ...operation, id: operationId };
  }
  private activeBinding(workspaceId: string, providerId: string): Promise<VcsBinding> {
    return this.deps.vcs.withWorkspace(workspaceId, providerId, async ({ workspace, binding }) => {
      if (workspace.archivedAt)
        throw new VcsError({
          code: "unavailable",
          message: "Restore the workspace before modifying its repository",
        });
      return binding;
    });
  }
  private async perform(
    workspaceId: string,
    current: VcsBinding,
    target: VcsPublication,
    action: VcsChangeRequestAction,
    operationId: string,
    context: VcsOperationContext,
  ) {
    await this.validate(current, target);
    if (action.action === "create" && !action.title.trim())
      throw new VcsError({ code: "provider", message: "A change request title is required" });
    const { service } = await this.resolveForge(target);
    context.signal.throwIfAborted();
    context.report({ publication: target, stage: "ready" });
    try {
      await this.publish(current, target, action, operationId, context);
      context.report({ publication: target, stage: "published" });
      context.signal.throwIfAborted();
      await this.activeBinding(workspaceId, current.providerId);
      await this.validate(current, target);
      service.invalidate({ cwd: current.cwd });
      const status = await service.getCurrentPullRequestStatus({
        cwd: current.cwd,
        headRef: target.headRef,
        headSha: target.headRevision,
        force: true,
        reason: "vcs-change-request-validation",
      });
      context.signal.throwIfAborted();
      await this.activeBinding(workspaceId, current.providerId);
      await this.deps.plugins.invokeVcs(current.providerId, {
        kind: "publication.verify",
        binding: current,
        target,
      });
      context.signal.throwIfAborted();
      context.started();
      const result = await this.apply(current, target, action, service, status);
      service.invalidate({ cwd: current.cwd });
      return result;
    } catch (error) {
      throw remoteError(error);
    }
  }
  private async publish(
    current: VcsBinding,
    target: VcsPublication,
    action: VcsChangeRequestAction,
    operationId: string,
    context: VcsOperationContext,
  ): Promise<void> {
    if (action.action === "create" && action.publish) {
      context.started();
      let response = await this.deps.plugins.invokeVcs(current.providerId, {
        kind: "publication.publish",
        binding: current,
        target,
        operationId: JSON.stringify(["publication.publish", operationId, current.providerId]),
      });
      if (response.kind !== "operation") throw new Error("Invalid publication operation response");
      const id = response.operation.id;
      while (response.operation.status === "pending" || response.operation.status === "running") {
        if (context.signal.aborted) {
          await this.deps.plugins.invokeVcs(current.providerId, {
            kind: "cancel",
            operationId: id,
          });
          context.signal.throwIfAborted();
        }
        await delay(25);
        response = await this.deps.plugins.invokeVcs(current.providerId, {
          kind: "operation",
          operationId: id,
        });
        if (response.kind !== "operation")
          throw new Error("Invalid publication operation response");
      }
      if (response.operation.status === "unknown")
        throw new VcsUnknownOutcomeError({
          code: "remote",
          message: "Push outcome is unknown; refresh before retrying",
        });
      if (response.operation.status !== "succeeded")
        throw new VcsError(
          response.operation.error ?? {
            code: "remote",
            message: "Push outcome is unknown; refresh before retrying",
          },
        );
    } else {
      await this.deps.plugins.invokeVcs(current.providerId, {
        kind: "publication.verify",
        binding: current,
        target,
      });
    }
  }
  private async apply(
    current: VcsBinding,
    target: VcsPublication,
    action: VcsChangeRequestAction,
    service: ForgeService,
    status: CurrentPullRequestStatus | null,
  ) {
    const published = { publication: target, stage: "published" as const };

    if (action.action === "create") {
      if (status?.state.toLowerCase() === "open" && status.baseRefName !== target.baseRef)
        throw new VcsError({
          code: "outdated",
          message:
            "An open change request uses a different base; select its base before opening it",
        });
      const result =
        status?.state.toLowerCase() === "open" && status.number
          ? { number: status.number, url: status.url }
          : await service.createPullRequest({
              cwd: current.cwd,
              title: action.title.trim(),
              body: action.body,
              head: target.headRef,
              base: target.baseRef,
            });
      service.invalidate({ cwd: current.cwd });
      return VcsPublicationResultSchema.parse({
        ...published,
        stage: "created",
        changeRequest: result,
      });
    }
    if (
      !status ||
      status.number !== action.number ||
      status.url !== action.url ||
      status.state.toLowerCase() !== "open"
    )
      throw new VcsError({
        code: "outdated",
        message: "The selected change request changed; refresh before trying again",
      });
    const options = { cwd: current.cwd, prNumber: action.number, status };
    if (action.action === "merge")
      await service.mergePullRequest({ ...options, mergeMethod: action.mergeMethod });
    else if (action.action === "enable-auto-merge")
      await service.enablePullRequestAutoMerge({ ...options, mergeMethod: action.mergeMethod });
    else await service.disablePullRequestAutoMerge(options);
    service.invalidate({ cwd: current.cwd });
    return VcsPublicationResultSchema.parse({
      ...published,
      stage: "updated",
      changeRequest: { number: status.number, url: status.url },
    });
  }
}
