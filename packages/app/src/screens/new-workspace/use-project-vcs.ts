import type { VcsSnapshot } from "@getpaseo/protocol/vcs";
import type { AgentAttachment, ForgeSearchItem } from "@getpaseo/protocol/messages";
import { useCallback } from "react";
import { useInstalledPlugins } from "@/plugins/registry";
import { resolveVcsContribution } from "@/vcs/contributions";
import type { PluginVcsProjectSource } from "@getpaseo/plugin/client";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useFetchQuery, useInfiniteFetchQuery } from "@/data/query";
import { useTranslation } from "react-i18next";
import {
  getHostProjectId,
  getWorktreeSupportForHostProject,
  type HostProjectListItem,
} from "@/projects/host-projects";
import { createPaseoApi } from "@getpaseo/client";
import { useHostFeature, useHostFeatureAvailabilityMap } from "@/runtime/host-features";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import {
  openIsolationForm,
  isCurrentIsolationState,
  type ProjectVcsInput,
} from "./isolation-model";
import { useWorkingCopyValidator } from "@/vcs/working-copy-fields";

export function useProjectVcs(
  serverId: string,
  project: HostProjectListItem | null,
  sourceDirectory: string | null,
  pickerOpen: boolean,
  changeRequest: ForgeSearchItem | undefined,
  onSourceAttachments: (attachments: readonly AgentAttachment[]) => void,
) {
  const { t } = useTranslation();
  const projectId = project ? getHostProjectId(project, serverId) : null;
  const feature = useHostFeatureAvailabilityMap([serverId], "vcsProjectReads").get(serverId);
  const supported = feature === true;
  const creationSupported = useHostFeature(serverId, "vcsWorkingCopySelection");
  const client = useHostRuntimeClient(serverId);
  const connected = useHostRuntimeIsConnected(serverId);
  const api = useMemo(() => (client ? createPaseoApi(client).projects.vcs : null), [client]);
  const identity = JSON.stringify([serverId, projectId]);
  const query = useFetchQuery({
    dataShape: "value",
    staleTimeMs: 0,
    queryKey: ["project-vcs-creation", serverId, projectId],
    enabled: supported && connected && !!api && !!projectId,
    retry: false,
    refetchOnWindowFocus: false,
    queryFn: () => {
      if (!api || !projectId) throw new Error("Choose a project");
      return api.snapshot(projectId);
    },
  });
  const context = useMemo<ProjectVcsInput>(() => {
    if (query.error) return { status: "error", message: query.error.message };
    if (query.data) return { status: "loaded", snapshot: query.data.snapshot };
    return { status: "loading" };
  }, [query.error, query.data]);
  const [model] = useState(openIsolationForm);
  const state = useSyncExternalStore(model.subscribe, model.getState, model.getState);
  useEffect(() => model.apply(identity, context), [model, identity, context]);
  useEffect(() => () => model.close(), [model]);
  const snapshot = context.status === "loaded" ? context.snapshot : null;
  const validate = useWorkingCopyValidator(serverId, snapshot);
  const { contribution, customSource, repositoryUrl } = useProjectContribution(serverId, snapshot);
  // COMPAT(newWorkspaceLegacyGit): added in v0.15.2, remove after the supported
  // daemon floor advertises vcsProjectReads. Older hosts retain their Git workflow.
  const legacy = feature === false;
  const history = useInfiniteFetchQuery<
    Awaited<ReturnType<NonNullable<typeof api>["history"]>>,
    string | undefined
  >({
    staleTimeMs: 30_000,
    queryKey: ["project-vcs-history", serverId, projectId, snapshot?.binding, snapshot?.version],
    enabled: !legacy && !customSource && connected && !!snapshot && pickerOpen,
    retry: false,
    refetchOnWindowFocus: false,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => {
      if (!api || !projectId || !snapshot) throw new Error("Project VCS is unavailable");
      return api.history(projectId, {
        providerId: snapshot.binding.providerId,
        version: snapshot.version,
        cursor: pageParam,
        limit: 50,
      });
    },
    getNextPageParam: (page) => page.cursor,
  });
  const scoped = visibleState(state, identity);
  const revision = scoped.revision;
  const revisions = useMemo(
    () => [
      ...new Map(
        [
          ...(revision ? [revision] : []),
          ...(snapshot?.current ? [snapshot.current] : []),
          ...(history.data?.pages.flatMap((page) => page.revisions) ?? []),
        ].map((item) => [item.id, item]),
      ).values(),
    ],
    [revision, snapshot, history.data],
  );
  return {
    sourceAttachments: scoped.sourceAttachments ?? [],
    projectSource: {
      projectId,
      changeRequest,
      contribution,
      custom: customSource,
      value: scoped.projectSource ?? null,
      onChange: useCallback(
        (source: PluginVcsProjectSource | null, attachments?: readonly AgentAttachment[]) => {
          if (!model.isCurrent(identity, snapshot)) return;
          model.setProjectSource(identity, source, attachments);
          onSourceAttachments(attachments ?? []);
        },
        [model, identity, snapshot, onSourceAttachments],
      ),
    },
    workingCopy: useMemo(
      () => ({
        key: JSON.stringify([identity, snapshot?.binding]),
        snapshot: isCurrentIsolationState(state, identity, snapshot) ? snapshot : null,
        revision: revision?.id ?? "",
        value: scoped.providerData,
        onChange: model.setProviderData,
      }),
      [identity, snapshot, revision, scoped.providerData, model, state],
    ),
    legacy,
    legacyPickerOpen: legacy && pickerOpen,
    composerRemoteUrl: legacy ? undefined : repositoryUrl,
    checkoutCwd: legacy ? (sourceDirectory ?? "") : "",
    copyLabel: legacy ? undefined : t("newWorkspace.isolation.workingCopy"),
    support: projectIsolationSupport(context, legacy, project, serverId),
    revision,
    revisions,
    history,
    error: context.status === "error" ? context.message : null,
    select: model.select,
    refresh: query.refetch,
    source: () => {
      if (!connected) throw new Error("Host is disconnected");
      if (!creationSupported) throw new Error("Update the host to create VCS working copies");
      if (!projectId) throw new Error("Choose a project");
      const source = model.source(identity, projectId, customSource);
      const error =
        !customSource && source.kind === "working-copy"
          ? validate(source.revision!, source.providerData)
          : null;
      if (error) throw new Error(error);
      return source;
    },
  };
}

function projectIsolationSupport(
  context: ProjectVcsInput,
  legacy: boolean,
  project: HostProjectListItem | null,
  serverId: string,
): "unknown" | "supported" | "unsupported" {
  if (!project) return "unsupported";
  if (legacy) return getWorktreeSupportForHostProject({ project, serverId });
  if (context.status !== "loaded") return "unknown";
  return context.snapshot?.capabilities.includes("working-copies") ? "supported" : "unsupported";
}

function visibleState(
  state: ReturnType<ReturnType<typeof openIsolationForm>["getState"]>,
  identity: string,
) {
  if (state.identity === identity) return state;
  return {
    ...state,
    revision: null,
    providerData: undefined,
    projectSource: null,
    sourceAttachments: [],
  };
}
function useProjectContribution(serverId: string, snapshot: VcsSnapshot | null) {
  const plugins = useInstalledPlugins();
  const contribution = snapshot
    ? resolveVcsContribution(plugins, serverId, snapshot.binding.providerId)
    : null;
  const repositoryUrl = snapshot
    ? (contribution?.contribution.repositoryUrl?.(snapshot) ?? null)
    : null;
  return { contribution, customSource: !!contribution?.contribution.ProjectSource, repositoryUrl };
}
