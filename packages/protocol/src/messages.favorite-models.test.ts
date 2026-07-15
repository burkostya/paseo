import { describe, expect, it } from "vitest";
import {
  FavoriteModelPreferenceSchema,
  FavoriteModelsChangedStatusPayloadSchema,
  ServerInfoStatusPayloadSchema,
  SessionInboundMessageSchema,
  SessionOutboundMessageSchema,
  StatusMessageSchema,
} from "./messages.js";

describe("favorite model sync protocol", () => {
  it("accepts the synthetic default model id", () => {
    expect(FavoriteModelPreferenceSchema.parse({ provider: "codex", modelId: "" })).toEqual({
      provider: "codex",
      modelId: "",
    });
  });

  it("keeps the server feature optional for older daemons", () => {
    expect(
      ServerInfoStatusPayloadSchema.parse({ status: "server_info", serverId: "server-1" }).features,
    ).toBeUndefined();
    expect(
      ServerInfoStatusPayloadSchema.parse({
        status: "server_info",
        serverId: "server-1",
        features: { favoriteModelsSync: true },
      }).features?.favoriteModelsSync,
    ).toBe(true);
  });

  it("parses get, initialize and idempotent set RPCs", () => {
    expect(
      SessionInboundMessageSchema.parse({
        type: "preferences.favorite_models.get.request",
        requestId: "get-1",
      }).type,
    ).toBe("preferences.favorite_models.get.request");
    expect(
      SessionInboundMessageSchema.parse({
        type: "preferences.favorite_models.initialize.request",
        favoriteModels: [{ provider: "codex", modelId: "" }],
        requestId: "initialize-1",
      }).type,
    ).toBe("preferences.favorite_models.initialize.request");
    expect(
      SessionInboundMessageSchema.parse({
        type: "preferences.favorite_models.set.request",
        provider: "codex",
        modelId: "gpt-5",
        favorite: true,
        requestId: "set-1",
      }).type,
    ).toBe("preferences.favorite_models.set.request");

    expect(
      SessionOutboundMessageSchema.parse({
        type: "preferences.favorite_models.set.response",
        payload: {
          requestId: "set-1",
          favoriteModels: [{ provider: "codex", modelId: "gpt-5" }],
          initialized: true,
        },
      }).type,
    ).toBe("preferences.favorite_models.set.response");
  });

  it("broadcasts changes through the backward-compatible status envelope", () => {
    const payload = {
      status: "preferences.favorite_models.changed" as const,
      favoriteModels: [{ provider: "codex", modelId: "gpt-5" }],
    };

    expect(FavoriteModelsChangedStatusPayloadSchema.parse(payload)).toEqual(payload);
    expect(StatusMessageSchema.parse({ type: "status", payload })).toEqual({
      type: "status",
      payload,
    });
  });
});
