import type { AgentAttachment } from "@getpaseo/protocol/messages";
import { VcsPluginSurface } from "@/vcs/plugin-surface";
import type { PluginSurfaceProps, PluginVcsProjectSource } from "@getpaseo/plugin/client";
import { useCallback, useMemo, useRef, useState, useEffect } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { Combobox } from "@/components/ui/combobox";
import { Button } from "@/components/ui/button";
import { vcsStyles } from "@/vcs/styles";
import { VcsWorkingCopyFields } from "@/vcs/working-copy-fields";
import { workingCopyRevisionLabel } from "@/vcs/working-copy-model";
import { FieldTrigger } from "./field-trigger";
import { branchIcon } from "./icons";
import type { useProjectVcs } from "../use-project-vcs";

interface Props {
  vcs: ReturnType<typeof useProjectVcs>;
  compact: boolean;
  disabled: boolean;
  open: boolean;
  onOpenChange(open: boolean): void;
}
export function useVcsRevisionField(props: Props & { visible: boolean }) {
  return useMemo(
    () =>
      props.visible && !props.vcs.legacy && !props.vcs.projectSource.custom ? (
        <VcsRevisionField {...props} />
      ) : undefined,
    [props],
  );
}
export function ProjectVcsError({ vcs, visible }: { vcs: Props["vcs"]; visible: boolean }) {
  const { t } = useTranslation();
  const retry = useCallback(() => {
    void vcs.refresh();
  }, [vcs]);
  if (!visible || !vcs.error) return null;
  return (
    <View>
      <Text accessibilityRole="alert" style={vcsStyles.error}>
        {vcs.error}
      </Text>
      <Button onPress={retry}>{t("vcs.refresh")}</Button>
    </View>
  );
}
function VcsRevisionField({ vcs, compact, disabled, open, onOpenChange }: Props) {
  const { t } = useTranslation();
  const anchor = useRef<View>(null);
  const options = useMemo(
    () =>
      vcs.revisions.map((revision) => ({
        id: revision.id,
        label: workingCopyRevisionLabel(revision),
      })),
    [vcs.revisions],
  );
  const openPicker = useCallback(() => onOpenChange(true), [onOpenChange]);
  const select = useCallback(
    (id: string) => {
      const revision = vcs.revisions.find((item) => item.id === id);
      if (revision) vcs.select(revision);
      onOpenChange(false);
    },
    [vcs, onOpenChange],
  );
  const loadMore = useCallback(() => {
    void vcs.history.fetchNextPage();
  }, [vcs.history]);
  const footer = useMemo(
    () => (
      <View>
        {vcs.history.error ? (
          <Text accessibilityRole="alert" style={vcsStyles.error}>
            {vcs.history.error.message}
          </Text>
        ) : null}
        {vcs.history.hasNextPage ? (
          <Button disabled={vcs.history.isFetchingNextPage} onPress={loadMore}>
            {t("vcs.loadMore")}
          </Button>
        ) : null}
      </View>
    ),
    [vcs.history.error, vcs.history.hasNextPage, vcs.history.isFetchingNextPage, loadMore, t],
  );
  return (
    <>
      <FieldTrigger
        ref={anchor}
        variant={compact ? "field" : "badge"}
        label={t("vcs.copyRevision")}
        accessibilityLabel={t("vcs.copyRevision")}
        icon={branchIcon}
        value={vcs.revision ? workingCopyRevisionLabel(vcs.revision) : t("vcs.copyRevision")}
        onPress={openPicker}
        disabled={disabled}
        testID="new-workspace-vcs-revision"
      />
      <Combobox
        options={options}
        value={vcs.revision?.id ?? ""}
        searchable
        title={t("vcs.copyRevision")}
        anchorRef={anchor}
        open={open}
        onOpenChange={onOpenChange}
        desktopPlacement="bottom-start"
        onSelect={select}
        footer={footer}
      />
    </>
  );
}

export function ProjectWorkingCopyFields({
  vcs,
  serverId,
  visible,
  disabled,
}: {
  vcs: Props["vcs"];
  serverId: string;
  visible: boolean;
  disabled: boolean;
}) {
  const fields = vcs.workingCopy;
  if (!visible || vcs.legacy || !fields.snapshot) return null;
  if (vcs.projectSource.custom)
    return <ProjectSourceForm key={fields.key} vcs={vcs} disabled={disabled} />;
  return (
    <VcsWorkingCopyFields
      key={fields.key}
      serverId={serverId}
      snapshot={fields.snapshot}
      revision={fields.revision}
      value={fields.value}
      onChange={fields.onChange}
      disabled={disabled}
    />
  );
}

function ProjectSourceForm({ vcs, disabled }: { vcs: Props["vcs"]; disabled: boolean }) {
  const { contribution, projectId, changeRequest, value, onChange } = vcs.projectSource;
  const snapshot = vcs.workingCopy.snapshot;
  const Form = contribution?.contribution.ProjectSource;
  const [lifetime] = useState(() => ({ active: true }));
  useEffect(
    () => () => {
      lifetime.active = false;
    },
    [lifetime],
  );
  const change = useCallback(
    (next: PluginVcsProjectSource | null, attachments?: readonly AgentAttachment[]) => {
      if (lifetime.active && !disabled) onChange(next, attachments);
    },
    [disabled, onChange, lifetime],
  );
  const context = useMemo(
    () => (snapshot && projectId ? { projectId, snapshot, changeRequest } : null),
    [snapshot, projectId, changeRequest],
  );
  const render = useCallback(
    (surface: PluginSurfaceProps) =>
      Form && context ? (
        <Form {...surface} context={context} value={value} disabled={disabled} onChange={change} />
      ) : null,
    [Form, context, value, disabled, change],
  );
  if (!contribution) return null;
  return <VcsPluginSurface plugin={contribution.plugin}>{render}</VcsPluginSurface>;
}
