import type { PaseoWorkspaceVcs } from "@getpaseo/client";
import type { JsonValue } from "@getpaseo/protocol/agent-types";
import type { VcsActionDialog } from "./action-sheet";

export async function prepareVcsConfirmation({
  vcs,
  dialog,
  input,
}: {
  vcs: Pick<PaseoWorkspaceVcs, "preview"> | null;
  dialog: VcsActionDialog;
  input: JsonValue;
}) {
  const { context, action, plugin } = dialog;
  const confirmation = action.confirm?.(context, input);
  const messages: string[] = [];
  if (confirmation) messages.push(plugin.i18n.resolve(confirmation.message, plugin.locale));
  const needsPreview = context.snapshot.actions.find((item) => item.id === action.id)?.preview;
  if (needsPreview) {
    if (!vcs) throw new Error("Host is unavailable");
    const preview = await vcs.preview(context.snapshot.binding.providerId, {
      version: context.snapshot.version,
      action: action.id,
      input,
    });
    messages.push(
      ...preview.revisions.map(
        (revision) =>
          `${revision.changeId ?? revision.id} (${revision.id}) ${revision.description.trim()}`,
      ),
    );
    messages.push(...preview.refs.map((ref) => `${ref.name}: ${ref.targets.join(", ")}`));
    messages.push(...preview.files);
  }
  return confirmation || needsPreview
    ? { message: messages.join("\n\n"), destructive: confirmation?.destructive }
    : null;
}
