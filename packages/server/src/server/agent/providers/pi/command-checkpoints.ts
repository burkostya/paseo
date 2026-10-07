import { z } from "zod";
import type { AgentSession, AgentStreamEvent } from "../../agent-sdk-types.js";

export const PiCommandCheckpointSchema = z.object({
  id: z.string().min(1),
  parentId: z.string().nullable(),
  text: z.string(),
  clientMessageId: z.string().optional(),
  timestamp: z.string(),
});

export type PiCommandCheckpoint = z.infer<typeof PiCommandCheckpointSchema>;
export const PiContextCommandCheckpointSchema = PiCommandCheckpointSchema.extend({
  messageIndex: z.number().int().nonnegative(),
});
export type PiContextCommandCheckpoint = z.infer<typeof PiContextCommandCheckpointSchema>;

export type PiCheckpointCommand =
  | { operation: "create"; text: string; clientMessageId?: string; trackPrompt: boolean }
  | { operation: "clear"; checkpointId: string; discard?: boolean };

export interface PiOutOfBandCommandInput {
  text: string;
  clientMessageId: string | undefined;
  emit: (event: AgentStreamEvent) => void;
  run: () => Promise<void>;
}

export const PiBranchNodeSchema = z.object({
  id: z.string().min(1),
  parentId: z.string().nullable(),
  timestamp: z.string(),
  type: z.string(),
  role: z.string().optional(),
});

export type PiBranchNode = z.infer<typeof PiBranchNodeSchema>;
export const PiCheckpointCaptureSchema = z.object({
  treeCheckpoints: PiCommandCheckpointSchema.array().default([]),
  contextCheckpoints: PiContextCommandCheckpointSchema.array().default([]),
  branchNodes: PiBranchNodeSchema.array().default([]),
});
export type ResolvePiRewindTargetInput = Parameters<
  NonNullable<AgentSession["resolveRewindTarget"]>
>[0];

export function resolveLegacyCommandLeaf(
  input: ResolvePiRewindTargetInput,
  branch: readonly PiBranchNode[],
): string | null {
  const submittedAt = Date.parse(input.timestamp);
  if (!Number.isFinite(submittedAt) || branch.length === 0) return null;
  const before: PiBranchNode[] = [];
  let crossedBoundary = false;
  for (const node of branch) {
    const timestamp = Date.parse(node.timestamp);
    if (!Number.isFinite(timestamp) || timestamp === submittedAt) return null;
    if (timestamp < submittedAt) {
      if (crossedBoundary) return null;
      before.push(node);
    } else {
      crossedBoundary = true;
    }
  }
  const leaf = before.at(-1);
  // navigateTree(user/custom_message) selects the parent, not the node itself.
  if (!leaf || leaf.role === "user" || leaf.type === "custom_message") return null;
  const precedingIds = new Set(before.map((node) => node.id));
  if (input.precedingProviderMessageIds.some((id) => !precedingIds.has(id))) return null;
  return `paseo-leaf:${leaf.id}`;
}
