import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { IssueTrackerConfig } from "@getpaseo/protocol/issue-trackers";
import { isWeb } from "@/constants/platform";
import { useToast } from "@/contexts/toast-context";
import { useHostIssueTrackers } from "@/issue-links/context";
import { openExternalUrl } from "@/utils/open-external-url";
import { getShortcutOs } from "@/utils/shortcut-platform";
import { useHosts } from "@/runtime/host-runtime";
import { useActiveWorkspaceSelection } from "@/stores/navigation-active-workspace-store";
import { hasIssueModifierForOs, resolveIssueLinkForHosts } from "@/issue-links/resolver";

type TrackersByServer = ReadonlyMap<string, readonly IssueTrackerConfig[]>;

function hasIssueModifier(event: MouseEvent): boolean {
  return hasIssueModifierForOs(getShortcutOs(), event);
}

function isExcludedTarget(target: HTMLElement): boolean {
  return Boolean(
    target.closest(
      "a, [role='link'], [data-issue-link], input, textarea, [contenteditable], [data-pmono], webview",
    ),
  );
}

function getTextAtPoint(event: MouseEvent): { text: string; offset: number } | null {
  const documentWithCaret = document as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  const position = documentWithCaret.caretPositionFromPoint?.(event.clientX, event.clientY);
  const range = position
    ? null
    : documentWithCaret.caretRangeFromPoint?.(event.clientX, event.clientY);
  const node = position?.offsetNode ?? range?.startContainer ?? null;
  const offset = position?.offset ?? range?.startOffset ?? null;
  if (!node || node.nodeType !== Node.TEXT_NODE || offset === null) return null;
  return { text: node.textContent ?? "", offset };
}

function HostIssueTrackerRegistration({
  serverId,
  onChange,
}: {
  serverId: string;
  onChange: (serverId: string, trackers: readonly IssueTrackerConfig[] | null) => void;
}) {
  const { supported, trackers } = useHostIssueTrackers(serverId);
  useEffect(() => {
    onChange(serverId, supported ? trackers : null);
    return () => onChange(serverId, null);
  }, [onChange, serverId, supported, trackers]);
  return null;
}

function WebIssueLinkModifierClickHandler() {
  const { t } = useTranslation();
  const toast = useToast();
  const hosts = useHosts();
  const activeSelection = useActiveWorkspaceSelection();
  const [trackersByServer, setTrackersByServer] = useState<TrackersByServer>(() => new Map());
  const serverIds = useMemo(() => hosts.map((host) => host.serverId), [hosts]);

  const handleTrackerChange = useCallback(
    (serverId: string, trackers: readonly IssueTrackerConfig[] | null) => {
      setTrackersByServer((current) => {
        const next = new Map(current);
        if (trackers) next.set(serverId, trackers);
        else next.delete(serverId);
        return next;
      });
    },
    [],
  );

  useEffect(() => {
    if (!isWeb || trackersByServer.size === 0) return;
    const handleClick = (event: MouseEvent) => {
      if (event.button !== 0 || !hasIssueModifier(event)) return;
      if (!(event.target instanceof HTMLElement) || isExcludedTarget(event.target)) return;

      const pointedText = getTextAtPoint(event);
      const fallbackText = event.target.textContent ?? "";
      const contextElement = event.target.closest<HTMLElement>("[data-issue-server-id]");
      const contextServerId = contextElement?.dataset.issueServerId?.trim() || null;
      const preferredServerId = contextServerId ?? activeSelection?.serverId ?? null;
      const resolution = resolveIssueLinkForHosts({
        text: pointedText?.text ?? fallbackText,
        offset: pointedText?.offset ?? null,
        preferredServerId,
        trackersByServer,
      });
      if (resolution.kind === "none") return;

      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      if (resolution.kind === "ambiguous") {
        toast.error(t("settings.host.issueTrackers.ambiguousHost"));
        return;
      }
      void openExternalUrl(resolution.match.url);
    };
    document.addEventListener("click", handleClick, true);
    return () => document.removeEventListener("click", handleClick, true);
  }, [activeSelection?.serverId, t, toast, trackersByServer]);

  return (
    <>
      {serverIds.map((serverId) => (
        <HostIssueTrackerRegistration
          key={serverId}
          serverId={serverId}
          onChange={handleTrackerChange}
        />
      ))}
    </>
  );
}

export function IssueLinkModifierClickHandler() {
  return isWeb ? <WebIssueLinkModifierClickHandler /> : null;
}
