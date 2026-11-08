import type { AgentAttachment, ForgeSearchItem } from "@getpaseo/protocol/messages";
import type { PaseoWorkspaceCreateOptions } from "@getpaseo/client";
import type { ComponentType } from "react";
import type { JsonValue } from "@getpaseo/protocol/agent-types";
import type { VcsRef, VcsRevision, VcsSnapshot, VcsData, VcsComparison } from "../vcs.js";
import type { PluginText } from "../text.js";
import type { PluginIcon, PluginSurfaceProps } from "./contracts.js";

export type PluginVcsSelection =
  | { kind: "workspace" }
  | { kind: "revision"; revision: VcsRevision }
  | { kind: "ref"; ref: VcsRef; revision: VcsRevision | null };
export interface PluginVcsContext {
  workspaceId: string;
  snapshot: VcsSnapshot;
  selection: PluginVcsSelection;
  revisions: readonly VcsRevision[];
  files: readonly string[];
  /** Whole files selected in a diff file or directory menu, including rename sources. */
  selectedFiles?: readonly string[];
}
export interface PluginVcsActionFormProps extends PluginSurfaceProps {
  context: PluginVcsContext;
  pending: boolean;
  submit(input: JsonValue): Promise<void>;
}
export interface PluginVcsConfirmation<Text extends PluginText = string> {
  message: Text;
  destructive?: boolean;
}
export type PluginVcsActionContribution<Text extends PluginText = string> = {
  /** Stable server action ID; labels are independent of the wire ID. */
  id: string;
  title: Text;
  icon?: PluginIcon;
  contexts: readonly PluginVcsSelection["kind"][];
  fileContexts?: readonly ("file" | "directory")[];
  confirm?(context: PluginVcsContext, input: JsonValue): PluginVcsConfirmation<Text>;
} & (
  | { Form: ComponentType<PluginVcsActionFormProps>; input?: never }
  | { Form?: never; input(context: PluginVcsContext): JsonValue }
);
export interface PluginVcsPanelProps extends PluginSurfaceProps {
  context: PluginVcsContext;
  refresh(): void;
  runAction(actionId: string, input: JsonValue): Promise<void>;
}
export interface PluginVcsPanelContribution<Text extends PluginText = string> {
  id: string;
  title: Text;
  icon?: PluginIcon;
  /** Opt in to navigation shortcuts; opening a panel never runs an action. */
  entryPoints?: readonly ("workspace" | "command-center")[];
  Component: ComponentType<PluginVcsPanelProps>;
}
/** Extra fields only: the host owns revision selection, submission and creation lifetime. */
export interface PluginVcsWorkingCopyFormProps extends PluginSurfaceProps {
  context: { snapshot: VcsSnapshot; revision: string };
  value: VcsData | undefined;
  disabled: boolean;
  onChange(value: VcsData | undefined): void;
}
/** A project source is submitted by the host through the normal creation executor. */
export type PluginVcsProjectSource = Exclude<
  PaseoWorkspaceCreateOptions["source"],
  { kind: "directory" }
>;
export interface PluginVcsProjectSourceProps extends PluginSurfaceProps {
  context: { projectId: string; snapshot: VcsSnapshot; changeRequest?: ForgeSearchItem };
  value: PluginVcsProjectSource | null;
  disabled: boolean;
  /** null blocks creation while the source is loading or invalid. */
  onChange(value: PluginVcsProjectSource | null, attachments?: readonly AgentAttachment[]): void;
}
export interface PluginVcsComparisonSettingsProps extends PluginSurfaceProps {
  snapshot: VcsSnapshot;
  value: VcsData | null;
  disabled: boolean;
  onChange(value: VcsData): void;
}
export interface PluginVcsContribution<Text extends PluginText = string> {
  ComparisonSettings?: ComponentType<PluginVcsComparisonSettingsProps>;
  providerId: string;
  title: Text;
  actions: readonly PluginVcsActionContribution<Text>[];
  comparisons?: readonly { id: string; title: Text }[];
  comparisonDefaultTitle?: Text;
  resolveComparison?(input: PluginVcsComparisonInput): PluginVcsComparisonResult;
  resolveRevisionComparison?(input: PluginVcsRevisionComparisonInput): PluginVcsComparisonResult;
  panels?: readonly PluginVcsPanelContribution<Text>[];
  /** Optional project-level source picker. The standard revision picker remains the default. */
  ProjectSource?: ComponentType<PluginVcsProjectSourceProps>;
  repositoryUrl?(snapshot: VcsSnapshot): string | null;
  workingCopy?: {
    Form: ComponentType<PluginVcsWorkingCopyFormProps>;
    /** Localized preflight feedback. The server still validates every request. */
    validate?(
      context: PluginVcsWorkingCopyFormProps["context"],
      value: VcsData | undefined,
    ): string | null;
  };
}

export interface PluginVcsComparisonInput {
  snapshot: VcsSnapshot;
  defaults?: VcsData;
  id?: string;
  baseRef?: string;
  ignoreWhitespace: boolean;
}
export interface PluginVcsComparisonResult {
  comparison: VcsComparison | null;
  error?: string;
  warning?: string;
  /** Omit to retain the standard selection/comparison review scope. */
  reviewScope?: string;
  baseRef?: string;
  selectBase?: boolean;
}

export interface PluginVcsRevisionComparisonInput {
  snapshot: VcsSnapshot;
  comparison: Exclude<VcsComparison, { kind: "working-copy" }>;
  ignoreWhitespace: boolean;
}
