import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { Pencil, Plus, Trash2 } from "lucide-react-native";
import { StyleSheet } from "react-native-unistyles";
import {
  buildIssueUrl,
  validateIssueTrackerConfigs,
  type IssueTrackerConfig,
  type IssueTrackerValidationCode,
} from "@getpaseo/protocol/issue-trackers";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { SettingsTextArea } from "@/components/settings-textarea";
import { Button } from "@/components/ui/button";
import { Field, FormTextInput } from "@/components/ui/form-field";
import type { EditingTextInputHandle } from "@/components/ui/text-input";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { useHostIssueTrackers } from "@/issue-links/context";
import { SettingsSection } from "@/screens/settings/settings-section";
import { settingsStyles } from "@/styles/settings";
import { confirmDialog } from "@/utils/confirm-dialog";

interface IssueTrackerDraft {
  name: string;
  urlTemplate: string;
  prefixes: string;
}

function createIssueTrackerId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID();
  return `issue-tracker-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function parsePrefixes(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((prefix) => prefix.trim())
    .filter(Boolean);
}

function validationMessageKey(
  code: IssueTrackerValidationCode,
):
  | "settings.host.issueTrackers.errors.duplicatePrefix"
  | "settings.host.issueTrackers.errors.invalidUrl"
  | "settings.host.issueTrackers.errors.missingPlaceholder"
  | "settings.host.issueTrackers.errors.nameRequired"
  | "settings.host.issueTrackers.errors.prefixRequired" {
  switch (code) {
    case "duplicate_prefix":
    case "duplicate_id":
      return "settings.host.issueTrackers.errors.duplicatePrefix";
    case "invalid_url_template":
      return "settings.host.issueTrackers.errors.invalidUrl";
    case "missing_id_placeholder":
      return "settings.host.issueTrackers.errors.missingPlaceholder";
    case "empty_name":
    case "empty_id":
      return "settings.host.issueTrackers.errors.nameRequired";
    case "empty_prefix":
    case "empty_prefixes":
      return "settings.host.issueTrackers.errors.prefixRequired";
  }
}

function IssueTrackerEditModal({
  visible,
  tracker,
  onClose,
  onSave,
}: {
  visible: boolean;
  tracker: IssueTrackerConfig | null;
  onClose: () => void;
  onSave: (draft: IssueTrackerDraft) => Promise<void>;
}) {
  const { t } = useTranslation();
  const initialDraft = useMemo<IssueTrackerDraft>(
    () => ({
      name: tracker?.name ?? "",
      urlTemplate: tracker?.urlTemplate ?? "",
      prefixes: tracker?.prefixes.join("\n") ?? "",
    }),
    [tracker],
  );
  const [name, setName] = useState(initialDraft.name);
  const [urlTemplate, setUrlTemplate] = useState(initialDraft.urlTemplate);
  const [prefixes, setPrefixes] = useState(initialDraft.prefixes);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const nameRef = useRef<EditingTextInputHandle>(null);
  const urlRef = useRef<EditingTextInputHandle>(null);

  useEffect(() => {
    if (!visible) return;
    setName(initialDraft.name);
    setUrlTemplate(initialDraft.urlTemplate);
    setPrefixes(initialDraft.prefixes);
    setSubmitError(null);
    setPending(false);
    const timeout = setTimeout(() => nameRef.current?.focus(), 50);
    return () => clearTimeout(timeout);
  }, [initialDraft, visible]);

  const header = useMemo<SheetHeader>(
    () => ({
      title: tracker
        ? t("settings.host.issueTrackers.editTitle")
        : t("settings.host.issueTrackers.addTitle"),
    }),
    [t, tracker],
  );
  const firstPrefix = parsePrefixes(prefixes)[0];
  const preview =
    firstPrefix && urlTemplate.includes("{id}")
      ? buildIssueUrl(urlTemplate.trim(), `${firstPrefix}123`)
      : null;

  const handleSave = useCallback(async () => {
    if (pending) return;
    setPending(true);
    setSubmitError(null);
    try {
      await onSave({ name: name.trim(), urlTemplate: urlTemplate.trim(), prefixes });
      onClose();
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : t("common.errors.unableToSave"));
    } finally {
      setPending(false);
    }
  }, [name, onClose, onSave, pending, prefixes, t, urlTemplate]);
  const handleNameSubmit = useCallback(() => urlRef.current?.focus(), []);

  return (
    <AdaptiveModalSheet
      visible={visible}
      header={header}
      onClose={onClose}
      desktopMaxWidth={520}
      testID="issue-tracker-edit-modal"
    >
      <View style={styles.modalBody}>
        <Field label={t("settings.host.issueTrackers.nameLabel")}>
          <FormTextInput
            ref={nameRef}
            initialValue={initialDraft.name}
            resetKey={`${visible}:${tracker?.id ?? "new"}:name`}
            onChangeText={setName}
            editable={!pending}
            returnKeyType="next"
            onSubmitEditing={handleNameSubmit}
            accessibilityLabel={t("settings.host.issueTrackers.nameLabel")}
            testID="issue-tracker-name-input"
          />
        </Field>
        <Field
          label={t("settings.host.issueTrackers.urlLabel")}
          hint={t("settings.host.issueTrackers.urlHint")}
        >
          <FormTextInput
            ref={urlRef}
            initialValue={initialDraft.urlTemplate}
            resetKey={`${visible}:${tracker?.id ?? "new"}:url`}
            onChangeText={setUrlTemplate}
            editable={!pending}
            autoCapitalize="none"
            autoCorrect={false}
            accessibilityLabel={t("settings.host.issueTrackers.urlLabel")}
            testID="issue-tracker-url-input"
          />
        </Field>
        <Field
          label={t("settings.host.issueTrackers.prefixesLabel")}
          hint={t("settings.host.issueTrackers.prefixesHint")}
        >
          <SettingsTextArea
            value={prefixes}
            onChangeText={setPrefixes}
            accessibilityLabel={t("settings.host.issueTrackers.prefixesLabel")}
            testID="issue-tracker-prefixes-input"
          />
        </Field>
        {preview ? (
          <View style={styles.preview}>
            <Text style={styles.previewLabel}>{t("settings.host.issueTrackers.preview")}</Text>
            <Text style={styles.previewUrl} selectable>
              {preview}
            </Text>
          </View>
        ) : null}
        {submitError ? <Text style={styles.error}>{submitError}</Text> : null}
        <View style={styles.modalActions}>
          <Button
            variant="secondary"
            style={styles.actionButton}
            onPress={onClose}
            disabled={pending}
          >
            {t("common.actions.cancel")}
          </Button>
          <Button
            style={styles.actionButton}
            onPress={handleSave}
            loading={pending}
            testID="issue-tracker-save"
          >
            {t("settings.host.issueTrackers.save")}
          </Button>
        </View>
      </View>
    </AdaptiveModalSheet>
  );
}

function IssueTrackerRow({
  tracker,
  onEdit,
  onRemove,
}: {
  tracker: IssueTrackerConfig;
  onEdit: (tracker: IssueTrackerConfig) => void;
  onRemove: (tracker: IssueTrackerConfig) => void;
}) {
  const { t } = useTranslation();
  const cardStyle = useMemo(() => [settingsStyles.card, styles.trackerCard], []);
  const handleEdit = useCallback(() => onEdit(tracker), [onEdit, tracker]);
  const handleRemove = useCallback(() => onRemove(tracker), [onRemove, tracker]);

  return (
    <View style={cardStyle}>
      <View style={styles.trackerText}>
        <Text style={settingsStyles.rowTitle}>{tracker.name}</Text>
        <Text style={settingsStyles.rowHint}>{tracker.prefixes.join(", ")}</Text>
        <Text style={settingsStyles.rowHint} numberOfLines={1}>
          {tracker.urlTemplate}
        </Text>
      </View>
      <Button
        size="xs"
        variant="ghost"
        leftIcon={Pencil}
        onPress={handleEdit}
        accessibilityLabel={t("settings.host.issueTrackers.editAccessibility", {
          name: tracker.name,
        })}
        testID={`issue-tracker-edit-${tracker.id}`}
      />
      <Button
        size="xs"
        variant="ghost"
        leftIcon={Trash2}
        onPress={handleRemove}
        accessibilityLabel={t("settings.host.issueTrackers.removeAccessibility", {
          name: tracker.name,
        })}
        testID={`issue-tracker-remove-${tracker.id}`}
      />
    </View>
  );
}

export function HostIssueTrackersPage({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const { supported, trackers, isLoading } = useHostIssueTrackers(serverId);
  const { patchConfig } = useDaemonConfig(supported ? serverId : null);
  const [editingTracker, setEditingTracker] = useState<IssueTrackerConfig | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);

  const saveTrackers = useCallback(
    async (next: IssueTrackerConfig[]) => {
      const validationIssue = validateIssueTrackerConfigs(next)[0];
      if (validationIssue) throw new Error(t(validationMessageKey(validationIssue.code)));
      await patchConfig({ issueTrackers: next });
    },
    [patchConfig, t],
  );

  const handleAdd = useCallback(() => {
    setEditingTracker(null);
    setEditorOpen(true);
  }, []);
  const handleEdit = useCallback((tracker: IssueTrackerConfig) => {
    setEditingTracker(tracker);
    setEditorOpen(true);
  }, []);
  const handleClose = useCallback(() => setEditorOpen(false), []);
  const handleSave = useCallback(
    async (draft: IssueTrackerDraft) => {
      const tracker: IssueTrackerConfig = {
        id: editingTracker?.id ?? createIssueTrackerId(),
        name: draft.name,
        urlTemplate: draft.urlTemplate,
        prefixes: parsePrefixes(draft.prefixes),
      };
      const next = editingTracker
        ? trackers.map((current) => (current.id === editingTracker.id ? tracker : current))
        : [...trackers, tracker];
      await saveTrackers(next);
    },
    [editingTracker, saveTrackers, trackers],
  );
  const handleRemove = useCallback(
    (tracker: IssueTrackerConfig) => {
      void (async () => {
        const confirmed = await confirmDialog({
          title: t("settings.host.issueTrackers.removeTitle"),
          message: t("settings.host.issueTrackers.removeMessage", { name: tracker.name }),
          confirmLabel: t("settings.host.issueTrackers.remove"),
          cancelLabel: t("common.actions.cancel"),
          destructive: true,
        });
        if (!confirmed) return;
        try {
          await saveTrackers(trackers.filter((current) => current.id !== tracker.id));
        } catch (error) {
          Alert.alert(
            t("common.errors.unableToSave"),
            error instanceof Error ? error.message : String(error),
          );
        }
      })();
    },
    [saveTrackers, t, trackers],
  );
  const addButton = useMemo(
    () => (
      <Button
        size="xs"
        variant="ghost"
        leftIcon={Plus}
        onPress={handleAdd}
        testID="issue-tracker-add"
      >
        {t("settings.host.issueTrackers.add")}
      </Button>
    ),
    [handleAdd, t],
  );

  if (!supported) {
    return <Text style={styles.empty}>{t("settings.host.issueTrackers.updateRequired")}</Text>;
  }
  if (isLoading) {
    return <Text style={styles.empty}>{t("common.loading")}</Text>;
  }

  return (
    <View>
      <SettingsSection title={t("settings.host.issueTrackers.sectionTitle")} trailing={addButton}>
        {trackers.length === 0 ? (
          <View style={settingsStyles.card}>
            <Text style={styles.empty}>{t("settings.host.issueTrackers.empty")}</Text>
          </View>
        ) : (
          trackers.map((tracker) => (
            <IssueTrackerRow
              key={tracker.id}
              tracker={tracker}
              onEdit={handleEdit}
              onRemove={handleRemove}
            />
          ))
        )}
      </SettingsSection>
      <IssueTrackerEditModal
        visible={editorOpen}
        tracker={editingTracker}
        onClose={handleClose}
        onSave={handleSave}
      />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  modalBody: { gap: theme.spacing[4], paddingBottom: theme.spacing[2] },
  modalActions: { flexDirection: "row", gap: theme.spacing[2] },
  actionButton: { flex: 1 },
  preview: { gap: theme.spacing[1] },
  previewLabel: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  previewUrl: { color: theme.colors.foreground, fontSize: theme.fontSize.sm },
  error: { color: theme.colors.statusDanger, fontSize: theme.fontSize.sm },
  empty: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    padding: theme.spacing[4],
  },
  trackerCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    padding: theme.spacing[4],
  },
  trackerText: { flex: 1, minWidth: 0 },
}));
