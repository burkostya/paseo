import { defineRpc } from "./rpc.js";
import { VcsRequestSchema, VcsResponseSchema } from "@getpaseo/protocol/vcs";
export * from "@getpaseo/protocol/vcs";

export function vcsRpc(providerId: string) {
  if (!/^[a-z][a-z0-9-]*$/.test(providerId))
    throw new Error(`Invalid VCS provider ID: ${providerId}`);
  return defineRpc({
    name: `vcs.${providerId}.request`,
    input: VcsRequestSchema,
    output: VcsResponseSchema,
  });
}

export { VcsObservationPlanSchema, type VcsObservationPlan } from "@getpaseo/protocol/vcs";
