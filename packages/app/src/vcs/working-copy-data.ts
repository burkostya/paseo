import { VcsDataSchema, type VcsData } from "@getpaseo/protocol/vcs";

// Plugin drafts must have the same value in persisted state and in a later retry.
export function copyWorkingCopyData(value: VcsData | undefined): VcsData | undefined {
  return value === undefined ? undefined : VcsDataSchema.parse(JSON.parse(JSON.stringify(value)));
}
