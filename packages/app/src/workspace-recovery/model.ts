import type { WorkspaceRecoveryState as AuthoritativeWorkspaceRecoveryState } from "@getpaseo/protocol/messages";

type AuthoritativeRecoverableWorkspace = Extract<
  AuthoritativeWorkspaceRecoveryState,
  { kind: "recoverable" }
>;

export type SupportedWorkspaceRecoveryAction = "unarchive" | "restore";

type SupportedRecoverableWorkspace = Omit<AuthoritativeRecoverableWorkspace, "action"> & {
  action: SupportedWorkspaceRecoveryAction;
};

export type WorkspaceRecoveryModel =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "needsHostUpgrade" }
  | {
      kind: "recoverable";
      recovery: SupportedRecoverableWorkspace;
      phase: "ready" | "restoring" | "failed";
      error: string | null;
      failedWorkspaceIds: string[];
    }
  | { kind: "unsupportedAction"; action: string }
  | {
      kind: "unavailable";
      recovery: Extract<AuthoritativeWorkspaceRecoveryState, { kind: "unavailable" }>;
    }
  | { kind: "inspectionFailed"; error: string };

export interface WorkspaceRecoveryController {
  state: WorkspaceRecoveryModel;
  restore: () => void;
  retryInspection: () => void;
}

export interface WorkspaceSelectionRecoveryClient {
  restoreWorkspace: (workspaceId: string) => Promise<unknown>;
  restoreWorkspaceSubtree?: (
    workspaceId: string,
    expectedWorkspaceIds: readonly string[],
  ) => Promise<{
    accepted: boolean;
    error: string | null;
    results: Array<{
      workspaceId: string;
      status: "succeeded" | "unchanged" | "failed";
      error: string | null;
    }>;
  }>;
  refreshAgent: (agentId: string) => Promise<unknown>;
}

export interface WorkspaceRecoveryRestoreResult {
  failedWorkspaceIds: string[];
}

export async function recoverWorkspaceSelection(input: {
  client: WorkspaceSelectionRecoveryClient;
  workspaceId: string;
  agentId?: string | null;
  expectedWorkspaceIds?: readonly string[];
}): Promise<WorkspaceRecoveryRestoreResult> {
  let failedWorkspaceIds: string[] = [];
  if (input.expectedWorkspaceIds && input.client.restoreWorkspaceSubtree) {
    const expectedWorkspaceIds = Array.from(new Set(input.expectedWorkspaceIds));
    const payload = await input.client.restoreWorkspaceSubtree(
      input.workspaceId,
      expectedWorkspaceIds,
    );
    if (!payload.accepted) {
      throw new Error(payload.error ?? "Workspace recovery was rejected by the host");
    }
    const resultsByWorkspaceId = new Map(
      payload.results.map((result) => [result.workspaceId, result]),
    );
    failedWorkspaceIds = expectedWorkspaceIds.filter(
      (workspaceId) =>
        resultsByWorkspaceId.get(workspaceId)?.status === "failed" ||
        !resultsByWorkspaceId.has(workspaceId),
    );
    const selectedResult = resultsByWorkspaceId.get(input.workspaceId);
    if (!selectedResult || selectedResult.status === "failed") {
      throw new Error(selectedResult?.error ?? "The selected workspace could not be recovered.");
    }
  } else {
    await input.client.restoreWorkspace(input.workspaceId);
  }
  if (input.agentId) {
    await input.client.refreshAgent(input.agentId);
  }
  return { failedWorkspaceIds };
}

function resolveRecoveryPhase(input: {
  pending: boolean;
  error: string | null;
  failedWorkspaceIds?: readonly string[];
}): "ready" | "restoring" | "failed" {
  if (input.pending) {
    return "restoring";
  }
  if (input.error || (input.failedWorkspaceIds?.length ?? 0) > 0) {
    return "failed";
  }
  return "ready";
}

function getSupportedRecovery(
  recovery: AuthoritativeWorkspaceRecoveryState | undefined,
): SupportedRecoverableWorkspace | null {
  if (recovery?.kind !== "recoverable") {
    return null;
  }
  if (recovery.action !== "restore" && recovery.action !== "unarchive") {
    return null;
  }
  return { ...recovery, action: recovery.action };
}

function resolveHierarchyInspectionState(input: {
  supportsHierarchy?: boolean;
  hierarchyInspection?: {
    pending: boolean;
    error: string | null;
    data:
      | {
          error: string | null;
          expectedWorkspaceIds: string[];
        }
      | undefined;
  };
}): WorkspaceRecoveryModel | null {
  if (!input.supportsHierarchy) return null;
  if (input.hierarchyInspection?.pending) return { kind: "checking" };
  const hierarchyError =
    input.hierarchyInspection?.error ?? input.hierarchyInspection?.data?.error ?? null;
  if (hierarchyError) return { kind: "inspectionFailed", error: hierarchyError };
  if (!input.hierarchyInspection?.data) return { kind: "checking" };
  return null;
}

export function resolveWorkspaceRecoveryModel(input: {
  enabled: boolean;
  connected: boolean;
  hasClient: boolean;
  hasServerInfo: boolean;
  supportsRecovery: boolean;
  supportsHierarchy?: boolean;
  inspection: {
    pending: boolean;
    error: string | null;
    data: AuthoritativeWorkspaceRecoveryState | undefined;
  };
  hierarchyInspection?: {
    pending: boolean;
    error: string | null;
    data:
      | {
          error: string | null;
          expectedWorkspaceIds: string[];
        }
      | undefined;
  };
  restore: {
    pending: boolean;
    error: string | null;
    data?: WorkspaceRecoveryRestoreResult;
  };
}): WorkspaceRecoveryModel {
  const supportedRecovery = getSupportedRecovery(input.inspection.data);
  if (input.restore.pending && supportedRecovery) {
    return {
      kind: "recoverable",
      recovery: supportedRecovery,
      phase: "restoring",
      error: null,
      failedWorkspaceIds: [],
    };
  }
  if (!input.enabled || !input.connected || !input.hasClient) {
    return { kind: "idle" };
  }
  if (!input.hasServerInfo) {
    return { kind: "checking" };
  }
  if (!input.supportsRecovery) {
    return { kind: "needsHostUpgrade" };
  }
  const hierarchyInspectionState = resolveHierarchyInspectionState(input);
  if (hierarchyInspectionState) return hierarchyInspectionState;
  if (input.inspection.pending) {
    return { kind: "checking" };
  }
  if (input.inspection.error) {
    return { kind: "inspectionFailed", error: input.inspection.error };
  }
  if (input.inspection.data?.kind === "unavailable") {
    return { kind: "unavailable", recovery: input.inspection.data };
  }
  if (input.inspection.data?.kind === "recoverable" && !supportedRecovery) {
    return { kind: "unsupportedAction", action: input.inspection.data.action };
  }
  if (supportedRecovery) {
    return {
      kind: "recoverable",
      recovery: supportedRecovery,
      phase: resolveRecoveryPhase({
        ...input.restore,
        failedWorkspaceIds: input.restore.data?.failedWorkspaceIds,
      }),
      error: input.restore.error,
      failedWorkspaceIds: input.restore.data?.failedWorkspaceIds ?? [],
    };
  }
  return { kind: "checking" };
}
