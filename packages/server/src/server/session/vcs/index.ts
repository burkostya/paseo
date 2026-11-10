import { savedVcsComparison } from "../../vcs-comparison-settings.js";
import { readComparisonContext } from "./comparison-context.js";
import { handleComparisonSettings } from "./comparison-settings.js";
import { resolveWorktreeCreationIntent } from "../../resolve-worktree-creation-intent.js";
import { resolveRepositoryDefaultBranch } from "../../../utils/checkout-git.js";
import { resolveWorkspaceVcsObservation } from "../../workspace-vcs-observation.js";
import { parseDiff, highlightDiffFromHunks } from "../../utils/diff-highlighter.js";
import type { ForgeResolver } from "../../../services/forge-resolver.js";
import { VcsError } from "@getpaseo/plugin/server/vcs";
import {
  VcsOutboundMessageSchema,
  type VcsInboundMessage,
  type VcsOutboundMessage,
} from "@getpaseo/protocol/vcs-rpc";
import type { VcsProblem, VcsResponse } from "@getpaseo/protocol/vcs";
import type { ProjectRegistry, WorkspaceRegistry } from "../../workspace-registry.js";
import { resolveWorkspaceVcsService, type VcsPlugins } from "../../workspace-vcs-service.js";

type WorkspaceVcsRequest = Extract<VcsInboundMessage, { workspaceId: string }>;
interface VcsRequestDependencies {
  runtime?: import("../../workspace-runtime-store/index.js").WorkspaceRuntimeStore;
  forge?: ForgeResolver;
  plugins?: VcsPlugins;
  projects: ProjectRegistry;
  workspaces: WorkspaceRegistry;
}

function projectResult(response: VcsResponse, request: WorkspaceVcsRequest): unknown {
  switch (response.kind) {
    case "comparison.resolved":
      return response.resolved;
    case "actions.preview":
      return response.preview;
    case "publication.remotes":
      return response.remotes;
    case "publication":
      return response.publication;
    case "snapshot":
      return response.snapshot;
    case "detect":
      return response.detection;
    case "history":
      return { revisions: response.revisions, cursor: response.cursor };
    case "diff":
      return {
        patch: response.patch,
        files: parseDiff(response.patch).map(highlightDiffFromHunks),
      };
    case "operation": {
      if (!("operationId" in request)) throw new Error("Unexpected VCS operation response");
      return { ...response.operation, id: request.operationId };
    }
    default:
      throw new Error("Unexpected VCS response");
  }
}
async function invokeWorkspaceRequest(
  request: WorkspaceVcsRequest,
  deps: VcsRequestDependencies & { plugins: VcsPlugins },
): Promise<unknown> {
  const { plugins } = deps;
  const vcs = resolveWorkspaceVcsService(deps);
  const workspace = await deps.workspaces.get(request.workspaceId);
  if (!workspace)
    throw new VcsError({
      code: "unavailable",
      message: `Unknown workspace: ${request.workspaceId}`,
    });
  if (
    workspace.archivedAt &&
    (request.type === "vcs.actions.execute.request" ||
      request.type === "vcs.publication.publish.request" ||
      request.type === "vcs.change-request.execute.request")
  )
    throw new VcsError({
      code: "unavailable",
      message: "Restore the workspace before modifying its repository",
    });
  // Operation lookup remains possible after selection changes or working-copy removal.
  if (
    request.type === "vcs.operations.get.request" ||
    request.type === "vcs.operations.cancel.request"
  ) {
    const operationId = JSON.stringify([request.workspaceId, request.operationId]);
    const hostOperation =
      request.type === "vcs.operations.get.request"
        ? vcs.publication.lookup(request.providerId, operationId)
        : vcs.publication.cancel(request.providerId, operationId);
    const response = hostOperation
      ? { kind: "operation" as const, operation: hostOperation }
      : await plugins.invokeVcs(request.providerId, {
          kind: request.type === "vcs.operations.get.request" ? "operation" : "cancel",
          operationId: JSON.stringify([request.workspaceId, request.operationId]),
        });
    if (response.kind === "operation")
      vcs.trackOperation(workspace.projectId, request.providerId, response.operation);
    return projectResult(response, request);
  }
  if (request.type === "vcs.repository.detect.request") {
    const providerId =
      request.providerId ?? (await vcs.getProjectSelection(workspace.projectId)).providerId;
    if (!providerId) return { status: "absent" };
    return projectResult(
      await plugins.invokeVcs(providerId, { kind: "detect", cwd: workspace.cwd }),
      request,
    );
  }
  return vcs.withWorkspace(
    request.workspaceId,
    request.providerId,
    async ({ binding, providerId, workspace: current }) => {
      let response: VcsResponse;
      switch (request.type) {
        case "vcs.snapshot.get.request":
          response = {
            kind: "snapshot",
            snapshot: await resolveWorkspaceVcsObservation(plugins).snapshot(binding),
          };
          break;
        case "vcs.history.list.request":
          response = await plugins.invokeVcs(providerId, {
            kind: "history",
            binding,
            limit: request.limit,
            cursor: request.cursor,
            version: request.version,
          });
          break;
        case "vcs.comparison.resolve.request": {
          const project = await deps.projects.get(current.projectId);
          if (!project) throw new Error("Project is unavailable");
          const settings =
            savedVcsComparison(current, providerId) ?? savedVcsComparison(project, providerId);
          response = await plugins.invokeVcs(providerId, {
            kind: "comparison.resolve",
            binding,
            input: request.input,
            settings,
          });
          break;
        }
        case "vcs.diff.get.request":
          response = await plugins.invokeVcs(providerId, {
            kind: "diff",
            binding,
            comparison: request.comparison,
          });
          break;
        case "vcs.publication.remotes.request":
          response = await plugins.invokeVcs(providerId, { kind: "publication.remotes", binding });
          break;
        case "vcs.publication.resolve.request":
          response = await plugins.invokeVcs(providerId, {
            kind: "publication.resolve",
            binding,
            selection: request.selection,
          });
          break;
        case "vcs.publication.publish.request":
          vcs.publication.assertUnreserved(
            providerId,
            JSON.stringify([request.workspaceId, request.operationId]),
          );
          response = await plugins.invokeVcs(providerId, {
            kind: "publication.publish",
            binding,
            target: request.target,
            operationId: JSON.stringify([request.workspaceId, request.operationId]),
          });
          break;
        case "vcs.change-request.get.request":
          // The client caches status reads. Explicit refresh and reconnect must reach the forge.
          return vcs.publication.status(request.workspaceId, binding, request.target, {
            force: true,
            reason: "vcs-publication-status",
          });
        case "vcs.change-request.execute.request": {
          const operation = await vcs.publication.execute({
            workspaceId: request.workspaceId,
            binding,
            operationId: JSON.stringify([request.workspaceId, request.operationId]),
            target: request.target,
            input: request.input,
          });
          vcs.trackOperation(current.projectId, providerId, operation);
          return { ...operation, id: request.operationId };
        }
        case "vcs.actions.preview.request":
          response = await plugins.invokeVcs(providerId, {
            kind: "actions.preview",
            binding,
            version: request.version,
            action: request.action,
            input: request.input,
          });
          break;
        case "vcs.actions.execute.request":
          vcs.publication.assertUnreserved(
            providerId,
            JSON.stringify([request.workspaceId, request.operationId]),
          );
          if (request.action.startsWith("working-copy."))
            throw new VcsError({
              code: "unavailable",
              message: "Use workspace creation to manage working copies",
            });
          response = await plugins.invokeVcs(providerId, {
            kind: "execute",
            binding,
            operationId: JSON.stringify([request.workspaceId, request.operationId]),
            version: request.version,
            action: request.action,
            input: request.input,
          });
          break;
      }
      if (response.kind === "operation")
        vcs.trackOperation(current.projectId, providerId, response.operation);
      return projectResult(response, request);
    },
  );
}
/** Only persisted project choice and daemon-resolved paths authorize VCS dispatch. */
export async function handleWorkspaceVcsRequest(
  request: VcsInboundMessage,
  deps: VcsRequestDependencies,
): Promise<VcsOutboundMessage> {
  const type = request.type.replace(/\.request$/, ".response");
  try {
    const plugins = requireVcsPlugins(deps.plugins);
    let result: unknown;
    const vcs = () => resolveWorkspaceVcsService({ ...deps, plugins });
    switch (request.type) {
      case "vcs.comparison.context.request":
        result = await readComparisonContext(request.binding, deps);
        break;
      case "vcs.comparison.get.request":
      case "vcs.comparison.set.request":
        result = await handleComparisonSettings(request, { ...deps, plugins });
        break;
      case "vcs.change-request.resolve-checkout.request":
        result = await resolveCheckout(request, deps);
        break;
      case "vcs.project.snapshot.get.request":
      case "vcs.project.working-copy.resolve-source.request":
      case "vcs.project.history.list.request": {
        const project = await deps.projects.get(request.projectId);
        if (!project || project.archivedAt)
          throw new VcsError({ code: "unavailable", message: "Project is unavailable" });
        const selection = await vcs().getProjectSelection(request.projectId);
        if (!selection.providerId && request.type === "vcs.project.snapshot.get.request") {
          result = { snapshot: null };
          break;
        }
        result = await vcs().withProjectBinding(
          request.projectId,
          project.rootPath,
          async (_, binding) => {
            if (request.type === "vcs.project.snapshot.get.request")
              return { snapshot: await resolveWorkspaceVcsObservation(plugins).snapshot(binding) };
            if (request.providerId !== binding.providerId)
              throw new VcsError({
                code: "outdated",
                message: "Project VCS changed; refresh the project",
              });
            if (request.type === "vcs.project.working-copy.resolve-source.request") {
              const response = await plugins.invokeVcs(binding.providerId, {
                kind: "working-copy.resolve-source",
                binding,
                input: request.input,
              });
              if (response.kind === "error") throw new VcsError(response.error);
              if (response.kind !== "working-copy.source")
                throw new Error("Invalid VCS working-copy source response");
              return response.source;
            }
            const response = await plugins.invokeVcs(binding.providerId, {
              kind: "history",
              binding,
              version: request.version,
              cursor: request.cursor,
              limit: request.limit,
            });
            if (response.kind !== "history") throw new Error("Invalid VCS history response");
            return { revisions: response.revisions, cursor: response.cursor };
          },
        );
        break;
      }
      case "vcs.local-files.list.request": {
        const response = await plugins.invokeVcs(request.binding.providerId, {
          kind: "local-files",
          binding: request.binding,
          query: request.query,
        });
        if (response.kind !== "local-files") throw new Error("Invalid VCS local files response");
        result = { paths: response.paths };
        break;
      }
      case "vcs.providers.list.request":
        result = plugins.listVcsProviders();
        break;
      case "vcs.project.get.request":
        result = await vcs().getProjectSelection(request.projectId);
        break;
      case "vcs.project.select.request":
        result = await vcs().selectProjectProvider(request.projectId, request.providerId);
        break;
      default:
        result = await invokeWorkspaceRequest(request, { ...deps, plugins });
    }
    return VcsOutboundMessageSchema.parse({
      type,
      payload: { requestId: request.requestId, result, error: null },
    });
  } catch (error) {
    const problem: VcsProblem =
      error instanceof VcsError
        ? error.problem
        : { code: "provider", message: error instanceof Error ? error.message : String(error) };
    return VcsOutboundMessageSchema.parse({
      type,
      payload: { requestId: request.requestId, result: null, error: problem },
    });
  }
}

async function resolveCheckout(
  request: Extract<VcsInboundMessage, { type: "vcs.change-request.resolve-checkout.request" }>,
  deps: VcsRequestDependencies,
) {
  const query = request.query;
  const resolved = await deps.forge?.resolveRepository(query.repositoryUrl);
  if (!resolved)
    throw new VcsError({ code: "unavailable", message: "No forge supports this repository" });
  return resolveWorktreeCreationIntent(
    {
      action: "checkout",
      checkoutSource: { kind: "change_request", forge: query.forge, number: query.number },
    },
    query.cwd,
    {
      forge: resolved.forge,
      forgeService: resolved.service,
      resolveDefaultBranch: async (cwd) => {
        const branch = await resolveRepositoryDefaultBranch(cwd);
        if (!branch) throw new Error("Select a repository default branch");
        return branch;
      },
    },
  );
}

function requireVcsPlugins(plugins: VcsPlugins | undefined): VcsPlugins {
  if (!plugins)
    throw new VcsError({ code: "unavailable", message: "VCS provider service is unavailable" });
  return plugins;
}
