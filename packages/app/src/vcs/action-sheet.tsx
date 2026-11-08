import { prepareVcsConfirmation } from "./action-confirmation";
import { useWorkspaceVcs } from "./queries";
import { useCallback, useMemo, useState, useRef } from "react";
import { Text, View } from "react-native";
import type { JsonValue } from "@getpaseo/protocol/agent-types";
import type {
  PluginVcsContext,
  PluginVcsActionContribution,
  PluginText,
  PluginSurfaceProps,
} from "@getpaseo/plugin/client";
import { useTranslation } from "react-i18next";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { confirmDialog } from "@/utils/confirm-dialog";
import type { InstalledPlugin } from "@/plugins/types";
import { VcsPluginSurface } from "./plugin-surface";
import { vcsStyles } from "./styles";
export interface VcsActionDialog {
  plugin: InstalledPlugin;
  action: PluginVcsActionContribution<PluginText>;
  context: PluginVcsContext;
}
interface Props {
  serverId: string;
  dialog: VcsActionDialog | null;
  pending: boolean;
  loading: boolean;
  error?: string;
  retry(): void;
  close(): void;
  execute(action: string, input: JsonValue, context: PluginVcsContext): Promise<void>;
}
export function VcsActionSheet(props: Props) {
  if (!props.dialog) return null;
  return (
    <OpenVcsActionSheet
      key={`${props.dialog.plugin.id}:${props.dialog.action.id}:${props.dialog.context.snapshot.version}`}
      {...props}
      dialog={props.dialog}
    />
  );
}
function OpenVcsActionSheet({
  dialog,
  serverId,
  pending: operationPending,
  loading,
  error: readError,
  retry,
  close,
  execute,
}: Omit<Props, "dialog"> & { dialog: VcsActionDialog }) {
  const { t } = useTranslation();
  const { vcs } = useWorkspaceVcs(serverId, dialog.context.workspaceId);
  const submitting = useRef(false);
  const [preparing, setPreparing] = useState(false);
  const pending = operationPending || preparing;
  const [error, setError] = useState<string | null>(null);
  const title = dialog.plugin.i18n.resolve(dialog.action.title, dialog.plugin.locale);
  const header = useMemo(() => ({ title }), [title]);
  const dismiss = useCallback(() => {
    if (!pending) close();
  }, [pending, close]);
  const submit = useCallback(
    async (input: JsonValue) => {
      if (submitting.current || operationPending) return;
      submitting.current = true;
      setPreparing(true);
      setError(null);
      try {
        const confirmation = await prepareVcsConfirmation({ vcs, dialog, input });
        if (
          confirmation &&
          !(await confirmDialog({
            title,
            message: confirmation.message,
            destructive: confirmation.destructive,
            confirmLabel: title,
            cancelLabel: t("common.cancel"),
          }))
        )
          return;
        await execute(dialog.action.id, input, dialog.context);
        close();
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : String(failure));
      } finally {
        submitting.current = false;
        setPreparing(false);
      }
    },
    [dialog, title, t, execute, close, vcs, operationPending],
  );
  const immediate = useCallback(() => {
    try {
      if (dialog.action.input) void submit(dialog.action.input(dialog.context));
    } catch (failure) {
      setError(String(failure));
    }
  }, [dialog, submit]);
  const render = useCallback(
    (surface: PluginSurfaceProps) => {
      const Component = dialog.action.Form;
      if (Component)
        return (
          <Component {...surface} context={dialog.context} pending={pending} submit={submit} />
        );
      return (
        <Button disabled={pending} onPress={immediate} testID="vcs-action-submit">
          {title}
        </Button>
      );
    },
    [dialog, pending, submit, immediate, title],
  );
  let content = <VcsPluginSurface plugin={dialog.plugin}>{render}</VcsPluginSurface>;
  if (loading) content = <Text style={vcsStyles.text}>{t("vcs.loading")}</Text>;
  if (readError)
    content = (
      <>
        <Text accessibilityRole="alert" style={vcsStyles.error}>
          {readError}
        </Text>
        <Button variant="ghost" onPress={retry}>
          {t("vcs.refresh")}
        </Button>
      </>
    );
  return (
    <AdaptiveModalSheet visible onClose={dismiss} header={header} testID="vcs-action-sheet">
      <View style={vcsStyles.form}>
        {error ? (
          <Text accessibilityRole="alert" style={vcsStyles.error}>
            {error}
          </Text>
        ) : null}
        {content}
      </View>
    </AdaptiveModalSheet>
  );
}
