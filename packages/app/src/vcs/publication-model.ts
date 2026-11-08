import type { VcsPublication, VcsPublicationSelection } from "@getpaseo/protocol/vcs";
import { matchesPublicationSelection, type PublicationFields } from "./publication-state";

type Lookup = { status: "idle" | "pending" } | { status: "failed"; message: string };
export interface PublicationFormState extends PublicationFields {
  canSubmit: boolean;
  canLookup: boolean;
  lookup: Lookup;
  lookupVersion: number;
}
function derive(
  fields: PublicationFields,
  lookup: Lookup,
  lookupVersion: number,
): PublicationFormState {
  const canLookup =
    !!(fields.remote && fields.headRef && fields.baseRef.trim()) && lookup.status !== "pending";
  return {
    ...fields,
    lookup,
    lookupVersion,
    canLookup,
    canSubmit: canLookup && !!fields.title.trim(),
  };
}
export function openPublicationForm(initial?: PublicationFields) {
  let fields: PublicationFields = initial ?? {
    remote: "",
    remoteLabel: "",
    headRef: "",
    headLabel: "",
    baseRef: "",
    title: "",
    body: "",
    target: null,
  };
  let lookup: Lookup = { status: "idle" };
  let lookupVersion = 0;
  let generation = 0;
  let closed = false;
  let state = derive(fields, lookup, lookupVersion);
  const listeners = new Set<() => void>();
  const publish = () => {
    state = derive(fields, lookup, lookupVersion);
    for (const listener of listeners) listener();
  };
  return {
    getState: () => state,
    getDraft: () => fields,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    set(
      field: "remote" | "headRef" | "baseRef" | "title" | "body",
      value: string,
      display?: string,
    ) {
      if (closed) return;
      const selectionChanged =
        ["remote", "headRef", "baseRef"].includes(field) && fields[field] !== value;
      if (selectionChanged) {
        generation++;
        lookup = { status: "idle" };
      }
      fields = {
        ...fields,
        [field]: value,
        ...(field === "remote" ? { remoteLabel: display ?? value } : {}),
        ...(field === "headRef" ? { headLabel: display ?? value } : {}),
        ...(selectionChanged ? { target: null } : {}),
      };
      publish();
    },
    async lookup(resolve: (selection: VcsPublicationSelection) => Promise<VcsPublication>) {
      if (closed || !state.canLookup) return;
      const owner = ++generation;
      const selection = {
        remote: fields.remote,
        headRef: fields.headRef,
        baseRef: fields.baseRef.trim(),
      };
      fields = { ...fields, target: null };
      lookup = { status: "pending" };
      publish();
      try {
        const target = await resolve(selection);
        if (closed || owner !== generation) return;
        if (!matchesPublicationSelection(fields, target))
          throw new Error("Publication target does not match the selected reference");
        fields = { ...fields, target };
        lookup = { status: "idle" };
        lookupVersion++;
      } catch (error) {
        if (closed || owner !== generation) return;
        lookup = {
          status: "failed",
          message: error instanceof Error ? error.message : String(error),
        };
      }
      publish();
    },
    close() {
      closed = true;
      generation++;
      listeners.clear();
    },
  };
}
