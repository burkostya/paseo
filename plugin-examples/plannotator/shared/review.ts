import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const reviewState = z.object({
  id: z.string(),
  agentId: z.string(),
  workspaceId: z.string(),
  status: z.enum([
    "starting",
    "reviewing",
    "sending",
    "sent",
    "delivery-failed",
    "cancelled",
    "failed",
  ]),
  url: z.string().nullable(),
  message: z.string().nullable(),
  error: z.string().nullable(),
});
export type ReviewState = z.infer<typeof reviewState>;
const target = z.object({ agentId: z.string(), workspaceId: z.string() });
const operation = target.extend({ reviewId: z.string() });
export const startReview = defineRpc({ name: "review.start", input: target, output: reviewState });
export const getReview = defineRpc({
  name: "review.get",
  input: target,
  output: reviewState.nullable(),
});
export const cancelReview = defineRpc({
  name: "review.cancel",
  input: operation,
  output: reviewState,
});
export const retryReview = defineRpc({
  name: "review.retry",
  input: operation,
  output: reviewState,
});
