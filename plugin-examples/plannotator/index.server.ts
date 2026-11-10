import type { PluginServerContext } from "@getpaseo/plugin/server";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  startReview,
  getReview,
  prepareReview,
  openReview,
  updateReview,
  cancelReview,
  retryReview,
  requestGuide,
  cancelGuide,
  preferences,
} from "./shared/review";
import { createReviews } from "./server/reviews";
import { createSource, createConversation } from "./server/source";
import { createEngine } from "./server/engine";
import { createStore } from "./server/store";
export default function contribute(server: PluginServerContext) {
  server.registerSettings(preferences);
  // The SDK bound to this plugin installation owns all daemon communication.
  let reviews: ReturnType<typeof createReviews> | null = null;
  function instance(paseo: import("@getpaseo/client").PaseoApi) {
    if (!reviews) {
      const conversation = createConversation(paseo);
      reviews = createReviews({
        conversation,
        source: createSource(paseo, conversation),
        engine: createEngine(process.env),
        store: createStore(
          join(process.env.PASEO_HOME ?? join(homedir(), ".paseo"), "plugin-data", "plannotator"),
        ),
      });
    }
    return reviews;
  }
  server.handle(prepareReview, (input, { paseo }) =>
    instance(paseo).prepare(input, input.selection),
  );
  server.handle(startReview, (input, { paseo }) => instance(paseo).start(input, input.selection));
  server.handle(getReview, (input, { paseo }) => instance(paseo).get(input));
  server.handle(openReview, (input, { paseo }) =>
    instance(paseo).open(input, input.viewRevisionId),
  );
  server.handle(updateReview, (input, { paseo }) => instance(paseo).update(input, input.selection));
  server.handle(cancelReview, (input, { paseo }) => instance(paseo).cancel(input));
  server.handle(retryReview, (input, { paseo }) => instance(paseo).retry(input, input.deliveryId));
  server.handle(requestGuide, (input, { paseo }) => instance(paseo).requestGuide(input));
  server.handle(cancelGuide, (input, { paseo }) =>
    instance(paseo).cancelGuide(input, input.requestId),
  );
  return async () => {
    await reviews?.stop();
  };
}
