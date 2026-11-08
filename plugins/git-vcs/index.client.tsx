import { ComparisonSettings } from "./client/comparison-settings.js";
import { ProjectSource } from "./client/project-source.js";
import { workingCopyOptions } from "./shared/working-copy.js";
import { WorkingCopyForm } from "./client/working-copy.js";
import { resolveGitComparison, resolveGitRevisionComparison } from "./client/comparison.js";
import type {
  PluginClientContext,
  PluginVcsActionContribution,
  PluginText,
} from "@getpaseo/plugin/client";
import { actionIds, actionInput } from "./shared/actions.js";
import { createGitActionForm } from "./client/form.js";
import { messages } from "./client/messages.js";
export default function contribute(client: PluginClientContext) {
  const actions = actionIds.map((id) => {
    const action: PluginVcsActionContribution<PluginText> = {
      id,
      title: messages.message(`actions.${id}`),
      icon: "GitBranch",
      contexts: ["restore", "branch-create", "merge"].includes(id)
        ? ["workspace", "revision", "ref"]
        : ["workspace"],
      fileContexts: ["stage", "unstage", "discard", "restore"].includes(id)
        ? ["file", "directory"]
        : undefined,
      Form: createGitActionForm(id),
    };
    if (["discard", "restore", "branch-delete", "merge", "commit"].includes(id))
      action.confirm = (context, input) => {
        const values = actionInput.parse({ ...(input as object), action: id });
        let files: string[] = [];
        if ("files" in values) files = values.files;
        else if (values.action === "commit")
          files = context.snapshot.files
            .filter((file) => values.all || ![" ", "?"].includes(file.status[0]!))
            .map((file) => file.path);
        return {
          message: [
            client.i18n.t(messages, "affected"),
            context.snapshot.current?.id,
            "revision" in values ? values.revision : undefined,
            "name" in values ? values.name : undefined,
            ...files,
          ]
            .filter(Boolean)
            .join("\n"),
          destructive: ["discard", "restore", "branch-delete"].includes(id),
        };
      };
    return action;
  });
  return client.addVcsContribution({
    ComparisonSettings,
    ProjectSource,
    repositoryUrl(snapshot) {
      const data = snapshot.data?.data;
      return data &&
        typeof data === "object" &&
        !Array.isArray(data) &&
        typeof data.remoteUrl === "string"
        ? data.remoteUrl
        : null;
    },
    workingCopy: {
      Form: WorkingCopyForm,
      validate(_context, value) {
        return value === undefined || workingCopyOptions.safeParse(value).success
          ? null
          : client.i18n.t(messages, "workingCopyInvalid");
      },
    },
    providerId: "git",
    title: messages.message("title"),
    actions,
    resolveComparison: resolveGitComparison,
    resolveRevisionComparison: resolveGitRevisionComparison,
    comparisons: ["combined", "committed", "all", "staged", "unstaged"].map((id) => ({
      id,
      title: messages.message(
        `comparisons.${id}` as
          | "comparisons.all"
          | "comparisons.staged"
          | "comparisons.unstaged"
          | "comparisons.combined"
          | "comparisons.committed",
      ),
    })),
  });
}
