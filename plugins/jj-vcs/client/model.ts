import type { PluginVcsContext } from "@getpaseo/plugin/client";
import type { JsonValue } from "@getpaseo/plugin";
import { actionInput, type JjAction } from "../shared/actions.js";
export type JjField = "revision" | "destination" | "message" | "name" | "remote";
export function openJjActionForm(action: JjAction, context: PluginVcsContext) {
  const selected =
    context.selection.kind === "workspace" ? context.snapshot.current : context.selection.revision;
  let revision = selected?.id ?? "";
  if (action === "restore" && context.selection.kind === "workspace") {
    revision = "";
    if (selected?.parents.length === 1) revision = selected.parents[0]!;
  }
  let values = {
    revision,
    destination: "",
    message: selected?.description ?? "",
    name: context.selection.kind === "ref" ? context.selection.ref.name : "",
    remote: context.selection.kind === "ref" ? (context.selection.ref.remote ?? "") : "",
    parents: selected ? [selected.id] : [],
    files: [...(context.selectedFiles ?? context.files)],
  };
  const listeners = new Set<() => void>();
  function input(): JsonValue {
    switch (action) {
      case "new":
        return { parents: values.parents };
      case "edit":
      case "abandon":
        return { revision: values.revision };
      case "describe":
        return { revision: values.revision, message: values.message };
      case "rebase":
        return { revision: values.revision, destination: values.destination };
      case "squash":
        return { revision: values.revision, destination: values.destination, files: values.files };
      case "split":
        return { revision: values.revision, message: values.message, files: values.files };
      case "restore":
        return { revision: values.revision, files: values.files };
      case "bookmark-create":
      case "bookmark-set":
        return { name: values.name, revision: values.revision };
      case "bookmark-delete":
        return { name: values.name };
      case "bookmark-track":
      case "push":
        return { name: values.name, remote: values.remote };
      case "fetch":
        return { remote: values.remote };
      case "update-stale":
        return {};
    }
  }
  function snapshot() {
    const candidate = input();
    const parsed = actionInput.safeParse({ action, ...(candidate as Record<string, JsonValue>) });
    const distinct =
      (action !== "squash" && action !== "rebase") || values.revision !== values.destination;
    return { ...values, valid: parsed.success && distinct, input: candidate };
  }
  let state = snapshot();
  function publish() {
    state = snapshot();
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
    set(field: JjField, value: string) {
      values = { ...values, [field]: value };
      publish();
    },
    toggleFile(file: string) {
      if (!context.files.includes(file)) return;
      values = {
        ...values,
        files: values.files.includes(file)
          ? values.files.filter((item) => item !== file)
          : [...values.files, file],
      };
      publish();
    },
    addParent(id: string) {
      if (values.parents.includes(id) || !context.revisions.some((item) => item.id === id)) return;
      values = { ...values, parents: [...values.parents, id] };
      publish();
    },
    removeParent(id: string) {
      values = { ...values, parents: values.parents.filter((item) => item !== id) };
      publish();
    },
    close() {
      listeners.clear();
    },
  };
}
export function jjFormFields(action: JjAction): JjField[] {
  switch (action) {
    case "describe":
    case "split":
      return ["revision", "message"];
    case "rebase":
    case "squash":
      return ["revision", "destination"];
    case "bookmark-create":
    case "bookmark-set":
      return ["revision", "name"];
    case "push":
    case "bookmark-track":
      return ["name", "remote"];
    case "bookmark-delete":
      return ["name"];
    case "fetch":
      return ["remote"];
    case "edit":
    case "abandon":
    case "restore":
      return ["revision"];
    case "new":
    case "update-stale":
      return [];
  }
}
