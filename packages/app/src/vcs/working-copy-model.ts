import { z } from "zod";
import type { VcsBinding, VcsRevision } from "@getpaseo/protocol/vcs";
import { VcsDataSchema, type VcsData } from "@getpaseo/protocol/vcs";
import { copyWorkingCopyData } from "./working-copy-data";

const intentSchema = z.object({
  idempotencyKey: z.string(),
  title: z.string(),
  source: z.object({
    kind: z.literal("working-copy"),
    projectId: z.string(),
    cwd: z.string(),
    providerId: z.string(),
    revision: z.string(),
    providerData: VcsDataSchema.optional(),
  }),
});
export const workingCopyDraftSchema = z.object({
  identity: z.string(),
  title: z.string(),
  revision: z.string(),
  revisionLabel: z.string(),
  providerData: VcsDataSchema.optional(),
  intent: intentSchema.nullable(),
  status: z.enum(["idle", "pending", "unknown", "succeeded", "failed"]),
  workspaceId: z.string().nullable(),
  error: z.string().nullable(),
});
export type WorkingCopyDraft = z.infer<typeof workingCopyDraftSchema>;
export type WorkingCopyIntent = z.infer<typeof intentSchema>;
export function workingCopyIdentity(projectId: string, binding: VcsBinding) {
  return JSON.stringify([
    projectId,
    binding.providerId,
    binding.repositoryId,
    binding.workingCopyId,
    binding.cwd,
  ]);
}
export function workingCopyRevisionLabel(revision: VcsRevision) {
  return `${revision.id} · ${revision.description.split("\n")[0]}`;
}
export function openWorkingCopyForm(input: {
  projectId: string;
  binding: VcsBinding;
  revision: VcsRevision | null;
  saved?: WorkingCopyDraft;
}) {
  const identity = workingCopyIdentity(input.projectId, input.binding);
  const saved = input.saved?.identity === identity ? input.saved : undefined;
  let state: WorkingCopyDraft = saved
    ? { ...saved, status: saved.status === "pending" ? "unknown" : saved.status }
    : {
        identity,
        title: "",
        revision: input.revision?.id ?? "",
        revisionLabel: input.revision ? workingCopyRevisionLabel(input.revision) : "",
        intent: null,
        status: "idle",
        workspaceId: null,
        error: null,
      };
  const listeners = new Set<() => void>();
  let closed = false;
  function update(next: WorkingCopyDraft) {
    if (closed) return;
    state = next;
    for (const listener of listeners) listener();
  }
  return {
    getState: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setTitle(title: string) {
      if (!state.intent) update({ ...state, title });
    },
    setProviderData(value: VcsData | undefined) {
      if (!state.intent) update({ ...state, providerData: copyWorkingCopyData(value) });
    },
    selectRevision(revision: VcsRevision) {
      if (!state.intent)
        update({
          ...state,
          revision: revision.id,
          revisionLabel: workingCopyRevisionLabel(revision),
        });
    },
    reset() {
      if (state.status === "succeeded" || state.status === "failed")
        update({ ...state, intent: null, status: "idle", workspaceId: null, error: null });
    },
    async submit(deps: {
      id(): string;
      validate?(revision: string, value: VcsData | undefined): string | null;
      create(
        request: WorkingCopyIntent,
      ): Promise<{ workspaceId: string | null; error: string | null }>;
    }) {
      if (
        closed ||
        !state.revision ||
        state.title.trim().length > 200 ||
        !["idle", "unknown"].includes(state.status)
      )
        return;
      // An uncertain request must be looked up unchanged, even after a plugin reload.
      let validation: string | null | undefined;
      try {
        validation = !state.intent ? deps.validate?.(state.revision, state.providerData) : null;
      } catch (error) {
        update({ ...state, error: error instanceof Error ? error.message : String(error) });
        return;
      }
      if (validation) {
        update({ ...state, error: validation });
        return;
      }
      const intent = state.intent ?? {
        idempotencyKey: deps.id(),
        title: state.title.trim(),
        source: {
          kind: "working-copy" as const,
          projectId: input.projectId,
          cwd: input.binding.cwd,
          providerId: input.binding.providerId,
          revision: state.revision,
          ...(state.providerData ? { providerData: copyWorkingCopyData(state.providerData) } : {}),
        },
      };
      update({ ...state, intent, status: "pending", error: null });
      try {
        const result = await deps.create(intent);
        update({ ...state, status: result.error ? "failed" : "succeeded", ...result });
      } catch (error) {
        update({
          ...state,
          status: "unknown",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
    close() {
      closed = true;
      listeners.clear();
    },
  };
}
