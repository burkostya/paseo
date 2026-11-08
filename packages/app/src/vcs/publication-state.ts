import { z } from "zod";
import {
  VcsPublicationSchema,
  VcsPublicationResultSchema,
  type VcsBinding,
  type VcsPublication,
  type VcsChangeRequest,
} from "@getpaseo/protocol/vcs";
import type { VcsPaneState } from "./state";

export const publicationDraftSchema = z.object({
  identity: z.string(),
  remote: z.string(),
  remoteLabel: z.string(),
  headRef: z.string(),
  headLabel: z.string(),
  baseRef: z.string(),
  title: z.string(),
  body: z.string(),
  target: VcsPublicationSchema.nullable(),
});
export type PublicationDraft = z.infer<typeof publicationDraftSchema>;
export type PublicationFields = Omit<PublicationDraft, "identity">;

export function publicationIdentity(binding: VcsBinding): string {
  return JSON.stringify([binding.providerId, binding.repositoryId, binding.workingCopyId]);
}

export function matchesPublicationSelection(
  fields: Pick<PublicationFields, "remote" | "headRef" | "baseRef">,
  target: VcsPublication,
): boolean {
  const selection = target.selection ?? target;
  return (
    fields.remote === selection.remote &&
    fields.headRef === selection.headRef &&
    fields.baseRef.trim() === selection.baseRef
  );
}

export function samePublication(left: VcsPublication, right: VcsPublication): boolean {
  return (
    JSON.stringify(VcsPublicationSchema.parse(left)) ===
    JSON.stringify(VcsPublicationSchema.parse(right))
  );
}

export function restorePublicationFields(
  state: VcsPaneState,
  identity: string,
): PublicationFields | undefined {
  if (state.publication)
    return state.publication.identity === identity ? state.publication : undefined;
  // COMPAT(vcsPublicationDraft): added in v0.15.2, remove after 2027-06-06 when operation-only publication panes expire.
  const request = state.operation?.request;
  if (request?.kind !== "publication") return;
  const selection = request.target.selection ?? request.target;
  return {
    remote: selection.remote,
    remoteLabel: selection.remote,
    headRef: selection.headRef,
    headLabel: selection.headRef,
    baseRef: selection.baseRef,
    target: request.target,
    title: request.input.action === "create" ? request.input.title : "",
    body: request.input.action === "create" ? request.input.body : "",
  };
}

export function publicationStatusView(input: {
  data?: { status: VcsChangeRequest | null };
  error: Error | null;
  isPending: boolean;
  result: unknown;
  target: VcsPublication;
}) {
  const status = input.error ? undefined : input.data?.status;
  const result = VcsPublicationResultSchema.safeParse(input.result);
  const createdUrl =
    result.success && samePublication(result.data.publication, input.target)
      ? result.data.changeRequest?.url
      : undefined;
  const requestUrl = input.error ? undefined : (status?.url ?? createdUrl);
  return { status, requestUrl, empty: !input.isPending && !input.error && !status && !requestUrl };
}
