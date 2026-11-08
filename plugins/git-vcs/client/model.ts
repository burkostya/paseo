import type { PluginVcsContext } from "@getpaseo/plugin/client";
import type { JsonValue } from "@getpaseo/plugin";
import { actionInput, snapshotData, type GitAction } from "../shared/actions.js";
export function openGitActionForm(action: GitAction, context: PluginVcsContext) {
  const selected = context.selection.kind === "workspace" ? null : context.selection.revision;
  const metadata = snapshotData.safeParse(context.snapshot.data);
  const candidates = context.snapshot.files.filter((file) => {
    if (action === "unstage") return ![" ", "?"].includes(file.status[0]!);
    if (action === "stage") return file.status[1] !== " ";
    return true;
  });
  const availableFiles =
    action === "restore"
      ? [...context.files]
      : candidates.flatMap((file) =>
          file.previousPath ? [file.path, file.previousPath] : [file.path],
        );
  const files = context.selectedFiles
    ? availableFiles.filter((file) => context.selectedFiles!.includes(file))
    : availableFiles;
  const branch = metadata.success ? (metadata.data.data.branch ?? "") : "";
  let values = {
    message: "",
    all: false,
    files: [...new Set(files)],
    remote: "",
    name: context.selection.kind === "ref" ? context.selection.ref.name : branch,
    revision:
      selected?.id ?? (action === "branch-create" ? (context.snapshot.current?.id ?? "") : ""),
  };
  if (action === "branch-create") values.name = "";
  const listeners = new Set<() => void>();
  function snapshot() {
    let input: JsonValue;
    switch (action) {
      case "stage":
      case "unstage":
      case "discard":
        input = { files: values.files };
        break;
      case "restore":
        input = { files: values.files, revision: values.revision };
        break;
      case "commit":
        input = { message: values.message, all: values.all };
        break;
      case "fetch":
        input = { remote: values.remote };
        break;
      case "push":
      case "pull":
      case "pull-and-push":
        input = { remote: values.remote, name: values.name };
        break;
      case "branch-create":
        input = { name: values.name, revision: values.revision };
        break;
      case "branch-switch":
      case "branch-delete":
        input = { name: values.name };
        break;
      case "merge":
        input = { revision: values.revision };
        break;
    }
    const staged = context.snapshot.files.some((file) => ![" ", "?"].includes(file.status[0]!));
    return {
      ...values,
      input,
      valid:
        actionInput.safeParse({ ...input, action }).success &&
        (action !== "commit" || values.all || staged),
    };
  }
  let state = snapshot();
  function publish() {
    state = snapshot();
    for (const listener of listeners) listener();
  }
  return {
    candidates: [...new Set(files)],
    getState: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    set(field: "message" | "name" | "remote" | "revision", value: string) {
      values = { ...values, [field]: value };
      publish();
    },
    setAll(all: boolean) {
      values = { ...values, all };
      publish();
    },
    toggleFile(file: string) {
      if (!files.includes(file)) return;
      values = {
        ...values,
        files: values.files.includes(file)
          ? values.files.filter((item) => item !== file)
          : [...values.files, file],
      };
      publish();
    },
    close() {
      listeners.clear();
    },
  };
}
export function gitFormFields(
  action: GitAction,
): Array<"message" | "name" | "remote" | "revision"> {
  switch (action) {
    case "commit":
      return ["message"];
    case "fetch":
      return ["remote"];
    case "push":
    case "pull":
    case "pull-and-push":
      return ["remote", "name"];
    case "branch-create":
      return ["name", "revision"];
    case "branch-switch":
    case "branch-delete":
      return ["name"];
    case "merge":
    case "restore":
      return ["revision"];
    default:
      return [];
  }
}
