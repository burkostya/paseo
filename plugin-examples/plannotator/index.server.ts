import type { PluginServerContext } from "@getpaseo/plugin/server";
import { startReview, getReview, cancelReview, retryReview } from "./shared/review";
import { createReviews } from "./server/reviews";
export default function contribute(server: PluginServerContext) {
  const reviews = createReviews();
  server.handle(startReview, (input, { paseo }) =>
    reviews.start(input.agentId, input.workspaceId, paseo),
  );
  server.handle(getReview, (input) => reviews.get(input.agentId, input.workspaceId));
  server.handle(cancelReview, (input, { paseo }) =>
    reviews.operate(input.agentId, input.workspaceId, input.reviewId, false, paseo),
  );
  server.handle(retryReview, (input, { paseo }) =>
    reviews.operate(input.agentId, input.workspaceId, input.reviewId, true, paseo),
  );
  return reviews.stop;
}
