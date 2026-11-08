import {
  DiffComparisonV2Schema,
  type DiffComparison,
  type DiffComparisonV2,
} from "@getpaseo/protocol/messages";
import type { VcsData } from "@getpaseo/protocol/vcs";

interface SettingsRecord {
  vcsComparisonSettings?: Record<string, VcsData | null>;
  diffComparison?: DiffComparison;
  diffComparisonV2?: DiffComparisonV2;
}

export function savedVcsComparison(
  record: SettingsRecord | null,
  providerId: string,
): VcsData | null {
  if (!record) return null;
  const saved = record.vcsComparisonSettings?.[providerId];
  if (saved !== undefined) return saved;
  // COMPAT(vcsComparisonSettings): v0.15.2; remove after legacy Git settings clients expire, 2027-06-06.
  if (providerId !== "git") return null;
  const legacy = record.diffComparison;
  const value =
    record.diffComparisonV2 ??
    (legacy?.mode === "base" ? { ...legacy, mode: "all" as const } : legacy);
  return value ? { version: 1, data: value } : null;
}

// COMPAT(vcsComparisonSettings): v0.15.2; legacy Git readers/writers remain projections until 2027-06-06.
export function gitComparisonProjection(record: SettingsRecord): DiffComparisonV2 | undefined {
  const value = savedVcsComparison(record, "git");
  return value ? DiffComparisonV2Schema.parse(value.data) : undefined;
}

export function legacyComparisonFields(providerId: string, value: VcsData | null) {
  if (providerId !== "git") return {};
  return {
    diffComparison: undefined,
    diffComparisonV2: value ? DiffComparisonV2Schema.parse(value.data) : undefined,
  };
}

export function workspaceComparisonDefaults(
  workspace: SettingsRecord,
  project: (SettingsRecord & { vcsProviderId?: string }) | null,
  resolved: {
    diffComparisonV2: DiffComparisonV2;
    diffComparisonResolvedBase: string | null;
    diffComparisonError: string | null;
    diffComparisonWarning: string | null;
  },
): VcsData | null {
  const providerId = project?.vcsProviderId;
  if (!providerId) return null;
  // COMPAT(vcsLegacyComparisonDefaults): v0.15.2; old clients consume resolved defaults. Remove after 2027-06-06; new clients use vcsSavedComparison and provider snapshots.
  if (providerId === "git")
    return {
      version: 1,
      data: {
        mode: resolved.diffComparisonV2.mode,
        baseRef: resolved.diffComparisonResolvedBase,
        error: resolved.diffComparisonError,
        warning: resolved.diffComparisonWarning,
      },
    };
  return savedVcsComparison(workspace, providerId) ?? savedVcsComparison(project, providerId);
}
