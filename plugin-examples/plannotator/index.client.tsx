import type { PluginClientContext } from "@getpaseo/plugin/client";
import { ReviewPanel } from "./client/review";
export default function contribute(client: PluginClientContext) {
  client.addAgentPanel({
    id: "review",
    title: "Code review",
    icon: "Scan",
    locations: ["workspace", "explorer"],
    Component: ReviewPanel,
  });
  client.addCommandCenterItem({
    id: "review",
    title: "Plannotator: Code review",
    icon: "Scan",
    context: "agent",
    onSelect({ openPanel }) {
      openPanel("review");
    },
  });
  return () => {};
}
