import { ComparisonSettings } from "./client/comparison-settings.js";
import { workingCopyOptions } from "./shared/working-copy.js";
import { WorkingCopyForm } from "./client/working-copy.js";
import type {
  PluginClientContext,
  PluginVcsSelection,
  PluginVcsActionContribution,
  PluginText,
} from "@getpaseo/plugin/client";
import { actionIds, rewritingActions, type JjAction } from "./shared/actions.js";
import { createJjActionForm } from "./client/form.js";
import { messages } from "./client/messages.js";
import { resolveJjComparison, resolveJjRevisionComparison } from "./client/comparison.js";
const icons: Record<JjAction, string> = {
  new: "Plus",
  edit: "Pencil",
  describe: "FilePenLine",
  abandon: "Trash2",
  rebase: "GitBranch",
  squash: "GitMerge",
  split: "Split",
  restore: "Undo2",
  "bookmark-create": "BookmarkPlus",
  "bookmark-set": "BookmarkCheck",
  "bookmark-delete": "BookmarkX",
  "bookmark-track": "Bookmark",
  fetch: "Download",
  push: "Upload",
  "update-stale": "RefreshCw",
};
function contexts(action: JjAction): PluginVcsSelection["kind"][] {
  if (action === "bookmark-delete" || action === "bookmark-track") return ["ref"];
  if (action === "update-stale") return ["workspace"];
  return ["workspace", "revision", "ref"];
}
export default function contribute(client: PluginClientContext) {
  const actions = actionIds.map((action) => {
    const contribution: PluginVcsActionContribution<PluginText> = {
      id: action,
      icon: icons[action],
      title: messages.message(`actions.${action}`),
      contexts: contexts(action),
      fileContexts: ["restore", "squash", "split"].includes(action)
        ? ["file", "directory"]
        : undefined,
      Form: createJjActionForm(action),
    };
    if (rewritingActions.has(action))
      contribution.confirm = () => ({
        message: client.i18n.t(messages, "affected"),
        destructive: action === "abandon" || action === "restore" || action === "bookmark-delete",
      });
    return contribution;
  });
  return client.addVcsContribution({
    ComparisonSettings,
    workingCopy: {
      Form: WorkingCopyForm,
      validate(_context, value) {
        return value === undefined || workingCopyOptions.safeParse(value).success
          ? null
          : client.i18n.t(messages, "workingCopyInvalid");
      },
    },
    providerId: "jj",
    title: messages.message("title"),
    resolveComparison: resolveJjComparison,
    resolveRevisionComparison: resolveJjRevisionComparison,
    comparisonDefaultTitle: messages.message("savedSettings"),
    comparisons: [
      { id: "change", title: messages.message("comparisonChange") },
      { id: "base", title: messages.message("comparisonBase") },
    ],
    actions,
  });
}
