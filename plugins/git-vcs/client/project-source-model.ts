import type { PluginVcsProjectSource, PluginVcsProjectSourceProps } from "@getpaseo/plugin/client";
import type { AgentAttachment, ForgeSearchItem } from "@getpaseo/protocol/messages";
import {
  workingCopyOptions,
  type SourceSelection,
  type ResolvedSource,
} from "../shared/working-copy.js";

interface Option {
  id: string;
  label: string;
  ref?: string;
  request?: ForgeSearchItem;
}
interface State {
  options: Option[];
  selected: Option | null;
  branch: string;
  query: string;
  loading: boolean;
  error: string | null;
  invalidBranch: boolean;
  branchExists: boolean;
  preparation:
    | { status: "idle" }
    | { status: "pending"; id: string }
    | { status: "ready"; id: string; value: ResolvedSource }
    | { status: "error"; id: string; message: string };
}
function requestAttachments(request: ForgeSearchItem | undefined): AgentAttachment[] {
  return request?.url
    ? [
        {
          type: "forge_change_request",
          mimeType: "application/paseo-forge-change-request",
          forge: request.forge ?? "github",
          number: request.number,
          title: request.title,
          url: request.url,
          body: request.body,
          baseRefName: request.baseRefName,
          headRefName: request.headRefName,
          ...(request.projectPath ? { projectPath: request.projectPath } : {}),
        },
      ]
    : [];
}
function savedSource(value: PluginVcsProjectSource | null) {
  const seed =
    value?.kind === "working-copy" && value.providerData
      ? workingCopyOptions.safeParse(value.providerData)
      : null;
  return seed?.success && seed.data.version === 2 ? seed.data.data : null;
}
export function openProjectSource(input: {
  context: PluginVcsProjectSourceProps["context"];
  value: PluginVcsProjectSource | null;
  onChange: PluginVcsProjectSourceProps["onChange"];
  resolve(selection: SourceSelection): Promise<ResolvedSource>;
}) {
  const { snapshot, projectId } = input.context;
  const snapshotMetadata = snapshot.data?.data;
  const metadata =
    snapshotMetadata && typeof snapshotMetadata === "object" && !Array.isArray(snapshotMetadata)
      ? snapshotMetadata
      : {};
  const remoteNames = new Set(
    snapshot.refs
      .filter((ref) => ref.id.startsWith("refs/remotes/origin/"))
      .map((ref) => ref.name.slice("origin/".length)),
  );
  const branchOptions: Option[] = snapshot.refs
    .filter(
      (ref) => (ref.kind === "branch" || ref.kind === "remote-branch") && !ref.id.endsWith("/HEAD"),
    )
    .map((ref) => {
      let label: string;
      if (ref.kind === "branch")
        label = `${ref.name}${remoteNames.has(ref.name) ? " (local)" : ""}`;
      else if (ref.name.startsWith("origin/")) label = ref.name.slice("origin/".length);
      else label = `${ref.name.slice(ref.name.indexOf("/") + 1)} (${ref.name.split("/")[0]})`;
      return { id: ref.id, ref: ref.id, label };
    });
  let defaultRef: string | null = null;
  if (typeof metadata.upstreamRef === "string") defaultRef = metadata.upstreamRef;
  else if (typeof metadata.branch === "string") defaultRef = `refs/heads/${metadata.branch}`;
  const saved = savedSource(input.value);
  const selectedRef = saved?.source.kind === "branch" ? saved.source.ref : defaultRef;
  let state: State = {
    options: branchOptions,
    selected: branchOptions.find((option) => option.ref === selectedRef) ?? null,
    branch: saved?.branch ?? "",
    query: "",
    loading: false,
    error: null,
    invalidBranch: false,
    branchExists: false,
    preparation: { status: "idle" },
  };
  if (state.selected)
    state.options = [
      state.selected,
      ...branchOptions.filter((option) => option.id !== state.selected!.id),
    ];
  if (saved?.source.kind === "change-request") {
    const target = saved.source.target;
    state.selected = {
      id: `request:${target.forge}:${target.changeRequestNumber}`,
      label: `#${target.changeRequestNumber}`,
      request: {
        kind: "change_request",
        forge: target.forge,
        number: target.changeRequestNumber,
        headRefName: target.headRef,
        title: "",
        url: "",
        state: "",
        body: null,
        labels: [],
      },
    };
    state.options = [state.selected, ...branchOptions];
  }
  let onChange = input.onChange;
  let activated = false;
  let closed = false;
  let generation = 0;
  let preparationGeneration = 0;
  const listeners = new Set<() => void>();
  function emit(next: State) {
    if (closed) return;
    state = next;
    for (const listener of listeners) listener();
  }
  function source() {
    if (closed) return;
    const selected = state.selected;
    const branch = state.branch.trim();
    const invalidBranch =
      !!branch &&
      !selected?.request &&
      !workingCopyOptions.safeParse({ version: 1, data: { branch } }).success;
    const branchExists =
      !selected?.request && branchOptions.some((option) => option.ref === `refs/heads/${branch}`);
    emit({ ...state, invalidBranch, branchExists });
    if (!selected || invalidBranch || branchExists) {
      onChange(null);
      return;
    }
    const request = selected.request;
    const attachments = requestAttachments(request);
    const preparation = state.preparation;
    if (preparation.status === "ready" && preparation.id === selected.id) {
      const data = preparation.value.data;
      if (data.version !== 2) throw new Error("Unsupported prepared source");
      onChange(
        {
          kind: "working-copy",
          projectId,
          providerId: snapshot.binding.providerId,
          cwd: snapshot.binding.cwd,
          revision: preparation.value.revision,
          providerData: {
            version: 2,
            data: { ...data.data, ...(branch && !request ? { branch } : {}) },
          },
        },
        attachments,
      );
      return;
    }
    onChange(null, attachments);
    if (preparation.status !== "idle" && preparation.id === selected.id) return;
    const token = ++preparationGeneration;
    emit({ ...state, preparation: { status: "pending", id: selected.id } });
    const selection: SourceSelection = request
      ? { kind: "change-request", forge: request.forge ?? "github", number: request.number }
      : { kind: "branch", ref: selected.ref! };
    void input
      .resolve(selection)
      .then((value) => {
        if (closed || token !== preparationGeneration) return;
        emit({ ...state, preparation: { status: "ready", id: selected.id, value } });
        return source();
      })
      .catch((error) => {
        if (!closed && token === preparationGeneration)
          emit({
            ...state,
            preparation: {
              status: "error",
              id: selected.id,
              message: error instanceof Error ? error.message : String(error),
            },
          });
      });
  }
  return {
    getState: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    activate(publish = onChange) {
      onChange = publish;
      if (!activated) {
        activated = true;
        source();
      }
    },
    applyChangeRequest(request: ForgeSearchItem | undefined) {
      if (!request || closed) return;
      const selected = {
        id: `request:${request.forge}:${request.number}`,
        label: `#${request.number} ${request.title}`,
        request,
      };
      emit({
        ...state,
        selected,
        preparation: { status: "idle" },
        options: [selected, ...state.options.filter((option) => option.id !== selected.id)],
      });
      source();
    },
    select(id: string) {
      preparationGeneration++;
      emit({
        ...state,
        selected: state.options.find((option) => option.id === id) ?? null,
        preparation: { status: "idle" },
      });
      source();
    },
    retrySource() {
      emit({ ...state, preparation: { status: "idle" } });
      source();
    },
    setBranch(branch: string) {
      emit({ ...state, branch });
      source();
    },
    setQuery(query: string) {
      emit({ ...state, query });
    },
    async search(run: (query: string) => Promise<ForgeSearchItem[]>) {
      const token = ++generation;
      emit({ ...state, loading: true, error: null });
      try {
        const items = await run(state.query);
        if (closed || token !== generation) return;
        const options: Option[] = items
          .filter((item) => item.kind === "change_request")
          .map((request) => ({
            id: `request:${request.forge}:${request.number}`,
            label: `#${request.number} ${request.title}`,
            request,
          }));
        emit({
          ...state,
          loading: false,
          options: [
            ...new Map(
              [...(state.selected ? [state.selected] : []), ...branchOptions, ...options].map(
                (option) => [option.id, option],
              ),
            ).values(),
          ],
        });
      } catch (error) {
        if (!closed && token === generation)
          emit({
            ...state,
            loading: false,
            error: error instanceof Error ? error.message : String(error),
          });
      }
    },
    close() {
      closed = true;
      generation++;
      preparationGeneration++;
      listeners.clear();
    },
  };
}
