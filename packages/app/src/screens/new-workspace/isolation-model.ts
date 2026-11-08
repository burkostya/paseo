import type { PluginVcsProjectSource } from "@getpaseo/plugin/client";
import { WorkspaceCreateRequestSchema, type AgentAttachment } from "@getpaseo/protocol/messages";
import type { VcsRevision, VcsSnapshot, VcsData } from "@getpaseo/protocol/vcs";
import { copyWorkingCopyData } from "@/vcs/working-copy-data";

export type ProjectVcsInput =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "loaded"; snapshot: VcsSnapshot | null };

interface IsolationFormState {
  identity: string;
  context: ProjectVcsInput;
  revision: VcsRevision | null;
  binding: string | null;
  providerData?: VcsData;
  projectSource?: PluginVcsProjectSource | null;
  sourceAttachments?: readonly AgentAttachment[];
}

export function openIsolationForm() {
  let state: IsolationFormState = {
    identity: "",
    context: { status: "loading" },
    revision: null,
    binding: null,
  };
  let closed = false;
  const listeners = new Set<() => void>();
  function publish(next: IsolationFormState) {
    if (closed) return;
    state = next;
    for (const listener of listeners) listener();
  }
  return {
    getState: () => state,
    isCurrent(identity: string, snapshot: VcsSnapshot | null) {
      return !closed && isCurrentIsolationState(state, identity, snapshot);
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    apply(identity: string, context: ProjectVcsInput) {
      if (identity === state.identity && context === state.context) return;
      const snapshot = context.status === "loaded" ? context.snapshot : null;
      const binding = snapshot ? JSON.stringify(snapshot.binding) : null;
      const sameTarget = identity === state.identity;
      const preserve = sameTarget && (context.status !== "loaded" || binding === state.binding);
      publish({
        identity,
        context,
        sourceAttachments: preserve ? state.sourceAttachments : undefined,
        projectSource: preserve ? state.projectSource : null,
        providerData: preserve ? state.providerData : undefined,
        binding: sameTarget && context.status !== "loaded" ? state.binding : binding,
        revision: preserve
          ? (state.revision ?? snapshot?.current ?? null)
          : (snapshot?.current ?? null),
      });
    },
    select(revision: VcsRevision) {
      publish({ ...state, revision });
    },
    setProviderData(value: VcsData | undefined) {
      publish({ ...state, providerData: copyWorkingCopyData(value) });
    },
    setProjectSource(
      identity: string,
      source: PluginVcsProjectSource | null,
      attachments: readonly AgentAttachment[] = [],
    ) {
      if (identity !== state.identity) return;
      const parsed =
        source === null
          ? null
          : WorkspaceCreateRequestSchema.shape.source.parse(JSON.parse(JSON.stringify(source)));
      if (parsed?.kind === "directory")
        throw new Error("An isolated workspace requires a working copy source");
      publish({
        ...state,
        projectSource: parsed,
        sourceAttachments: JSON.parse(JSON.stringify(attachments)),
      });
    },
    source(identity: string, projectId: string, customSource = false) {
      if (state.identity !== identity || state.context.status === "loading")
        throw new Error("Wait for project VCS state to load");
      if (state.context.status === "error") throw new Error(state.context.message);
      const snapshot = state.context.snapshot;
      const action = snapshot?.actions.find((item) => item.id === "working-copy.create");
      if (!snapshot?.capabilities.includes("working-copies") || !action?.enabled)
        throw new Error(action?.reason ?? "Working copy creation is unavailable");
      if (customSource) {
        const source = state.projectSource;
        if (!source) throw new Error("Select a source before creating a working copy");
        if (
          source.projectId !== projectId ||
          source.cwd !== snapshot.binding.cwd ||
          (source.kind === "working-copy" && source.providerId !== snapshot.binding.providerId)
        )
          throw new Error("Working copy source no longer matches the selected project");
        return JSON.parse(JSON.stringify(source)) as PluginVcsProjectSource;
      }
      if (!state.revision) throw new Error("Select a revision before creating a working copy");
      return {
        kind: "working-copy" as const,
        projectId,
        cwd: snapshot.binding.cwd,
        providerId: snapshot.binding.providerId,
        revision: state.revision.id,
        ...(state.providerData ? { providerData: copyWorkingCopyData(state.providerData) } : {}),
      };
    },
    close() {
      closed = true;
      listeners.clear();
    },
  };
}

export function isCurrentIsolationState(
  state: IsolationFormState,
  identity: string,
  snapshot: VcsSnapshot | null,
) {
  return (
    state.identity === identity &&
    state.binding === JSON.stringify(snapshot?.binding) &&
    state.context.status === "loaded"
  );
}
