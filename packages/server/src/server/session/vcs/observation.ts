import { CLIENT_CAPS } from "@getpaseo/protocol/client-capabilities";
import type { VcsInboundMessage } from "@getpaseo/protocol/vcs-rpc";
import type { SessionDelivery } from "../owned-subscriptions/index.js";
import type { SessionOutboundMessage } from "@getpaseo/protocol/messages";
import type { ProjectRegistry, WorkspaceRegistry } from "../../workspace-registry.js";
import { resolveWorkspaceVcsService, type VcsPlugins } from "../../workspace-vcs-service.js";
import {
  resolveWorkspaceVcsObservation,
  type VcsObservationValue,
} from "../../workspace-vcs-observation.js";
import { VcsError } from "@getpaseo/plugin/server/vcs";

export async function handleVcsObservation(
  request: Extract<VcsInboundMessage, { type: "vcs.snapshot.get.request" }>,
  deps: {
    plugins?: VcsPlugins;
    workspaces: WorkspaceRegistry;
    projects: ProjectRegistry;
    delivery: SessionDelivery;
    supports(
      capability: typeof CLIENT_CAPS.vcsObservation | typeof CLIENT_CAPS.ownedSubscriptions,
    ): boolean;
    emit(message: SessionOutboundMessage): void;
  },
) {
  const plugins = deps.plugins;
  if (
    !plugins ||
    !deps.supports(CLIENT_CAPS.vcsObservation) ||
    !deps.supports(CLIENT_CAPS.ownedSubscriptions)
  ) {
    deps.emit({
      type: "vcs.snapshot.get.response",
      payload: {
        requestId: request.requestId,
        result: null,
        error: {
          code: "unavailable",
          message: "VCS observation requires an available provider and client subscription support",
        },
      },
    });
    return;
  }
  const service = resolveWorkspaceVcsObservation(plugins);
  let stopProject: (() => void) | undefined;
  let stopWorkspace: (() => void) | undefined;
  let subscription: ReturnType<typeof service.subscribe> | undefined;
  // Source cleanup must also own resources registered after asynchronous bootstrap reads.
  let finishOpening!: () => void;
  const opening = new Promise<void>((resolve) => {
    finishOpening = resolve;
  });
  const owner = deps.delivery.begin("vcs", request.subscribe?.subscriptionId, async () => {
    await opening;
    stopProject?.();
    stopWorkspace?.();
    await (await subscription?.catch(() => null))?.unsubscribe();
  });
  let bootstrapping = true;
  let buffered: VcsObservationValue | undefined;
  const receive = (value: VcsObservationValue) => {
    if (bootstrapping) {
      buffered = value;
      return;
    }
    owner.emit({
      type: "vcs.snapshot.changed",
      payload: { ...value, workspaceId: request.workspaceId, subscriptionId: owner.responseId },
    });
  };
  try {
    const vcs = resolveWorkspaceVcsService({
      plugins,
      projects: deps.projects,
      workspaces: deps.workspaces,
    });
    const workspace = await deps.workspaces.get(request.workspaceId);
    owner.signal.throwIfAborted();
    if (!workspace || workspace.archivedAt)
      throw new VcsError({
        code: "unavailable",
        message: "Workspace is unavailable for observation",
      });
    const providerId =
      request.providerId ?? (await vcs.getProjectSelection(workspace.projectId)).providerId;
    owner.signal.throwIfAborted();
    const revalidate = async () => {
      const current = await deps.workspaces.get(request.workspaceId);
      const project = await deps.projects.get(workspace.projectId);
      if (
        !current ||
        current.archivedAt ||
        !project ||
        project.archivedAt ||
        project.vcsProviderId !== providerId ||
        current.cwd !== workspace.cwd
      ) {
        receive({
          result: null,
          error: {
            code: "outdated",
            message: "Workspace or VCS selection changed; reopen observation",
          },
        });
        if (bootstrapping) void owner.release();
        else await owner.release();
      }
    };
    stopProject = deps.projects.subscribeToMutations?.(() => {
      return revalidate();
    });
    stopWorkspace = deps.workspaces.subscribeToMutations?.(() => {
      return revalidate();
    });
    subscription = vcs.withWorkspace(request.workspaceId, request.providerId, ({ binding }) => {
      owner.signal.throwIfAborted();
      return service.subscribe(binding, receive, owner.signal);
    });
    const initial = await subscription;
    finishOpening();
    await revalidate();
    if (owner.signal.aborted)
      throw new VcsError({
        code: "outdated",
        message: "Observation was cancelled while opening the workspace",
      });
    owner.emit({
      type: "vcs.snapshot.get.response",
      payload: {
        requestId: request.requestId,
        subscriptionId: owner.responseId,
        result: initial.snapshot,
        error: null,
      },
    });
    bootstrapping = false;
    if (buffered && JSON.stringify(buffered.result) !== JSON.stringify(initial.snapshot))
      receive(buffered);
  } catch (error) {
    finishOpening();
    await owner.release();
    deps.emit({
      type: "vcs.snapshot.get.response",
      payload: {
        requestId: request.requestId,
        result: null,
        error:
          error instanceof VcsError
            ? error.problem
            : { code: "provider", message: error instanceof Error ? error.message : String(error) },
      },
    });
  }
}
