import type { PluginClientContext } from "@getpaseo/plugin/client";
import { messages } from "./client/messages.js";
import { CheckpointForm, CheckpointDetails } from "./client/panels.js";

export default function contribute(client: PluginClientContext) {
  return client.addVcsContribution({
    providerId: "checkpoint-vcs",
    title: messages.message("title"),
    actions: [
      {
        id: "checkpoint.create",
        title: messages.message("create"),
        icon: "Save",
        contexts: ["workspace"],
        Form: CheckpointForm,
      },
    ],
    panels: [
      {
        id: "details",
        title: messages.message("details"),
        icon: "Info",
        entryPoints: ["workspace", "command-center"],
        Component: CheckpointDetails,
      },
    ],
  });
}
