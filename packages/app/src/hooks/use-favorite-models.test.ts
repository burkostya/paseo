import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { favoriteModelsQueryKey } from "@/data/favorite-models";
import {
  fetchFavoriteModels,
  resolveEffectiveFavoriteModels,
  setFavoriteInSnapshot,
  setSyncedFavoriteModel,
  type FavoriteModelsClient,
} from "./favorite-models";

function createClient(overrides: Partial<FavoriteModelsClient> = {}): FavoriteModelsClient {
  return {
    getFavoriteModels: vi.fn(async () => ({
      requestId: "get-1",
      favoriteModels: [],
      initialized: false,
    })),
    initializeFavoriteModels: vi.fn(async (favoriteModels) => ({
      requestId: "initialize-1",
      favoriteModels,
      initialized: true,
    })),
    setFavoriteModel: vi.fn(async ({ provider, modelId, favorite }) => ({
      requestId: "set-1",
      favoriteModels: favorite ? [{ provider, modelId }] : [],
      initialized: true,
    })),
    ...overrides,
  } as FavoriteModelsClient;
}

describe("favorite model host replica", () => {
  it("uses an initialized host as authoritative without merging legacy favorites", async () => {
    const initializeFavoriteModels = vi.fn();
    const client = createClient({
      getFavoriteModels: vi.fn(async () => ({
        requestId: "get-1",
        favoriteModels: [{ provider: "claude", modelId: "sonnet" }],
        initialized: true,
      })),
      initializeFavoriteModels,
    });

    await expect(
      fetchFavoriteModels({
        client,
        legacyFavorites: [{ provider: "codex", modelId: "gpt-5" }],
      }),
    ).resolves.toEqual({
      favoriteModels: [{ provider: "claude", modelId: "sonnet" }],
      initialized: true,
    });
    expect(initializeFavoriteModels).not.toHaveBeenCalled();
  });

  it("seeds an uninitialized host from a non-empty deduplicated legacy list", async () => {
    const initializeFavoriteModels = vi.fn(async (favoriteModels) => ({
      requestId: "initialize-1",
      favoriteModels,
      initialized: true,
    }));
    const client = createClient({ initializeFavoriteModels });

    await fetchFavoriteModels({
      client,
      legacyFavorites: [
        { provider: "codex", modelId: "gpt-5" },
        { provider: "codex", modelId: "gpt-5" },
        { provider: "claude", modelId: "" },
      ],
    });

    expect(initializeFavoriteModels).toHaveBeenCalledWith([
      { provider: "codex", modelId: "gpt-5" },
      { provider: "claude", modelId: "" },
    ]);
  });

  it("leaves an uninitialized host available for another client's non-empty seed", async () => {
    const initializeFavoriteModels = vi.fn();
    const client = createClient({ initializeFavoriteModels });

    await expect(fetchFavoriteModels({ client, legacyFavorites: [] })).resolves.toEqual({
      favoriteModels: [],
      initialized: false,
    });
    expect(initializeFavoriteModels).not.toHaveBeenCalled();
  });

  it("uses local favorites only when host sync is unavailable", () => {
    const legacy = [{ provider: "codex", modelId: "gpt-5" }];
    const synced = {
      favoriteModels: [{ provider: "claude", modelId: "sonnet" }],
      initialized: true,
    };

    expect(resolveEffectiveFavoriteModels({ supportsSync: false, synced, legacy })).toEqual(legacy);
    expect(resolveEffectiveFavoriteModels({ supportsSync: true, synced, legacy })).toEqual(
      synced.favoriteModels,
    );
    expect(
      resolveEffectiveFavoriteModels({ supportsSync: true, synced: undefined, legacy }),
    ).toEqual([]);
  });

  it("applies explicit favorite state without toggling unrelated entries", () => {
    expect(
      setFavoriteInSnapshot({
        snapshot: {
          favoriteModels: [{ provider: "claude", modelId: "sonnet" }],
          initialized: true,
        },
        provider: "codex",
        modelId: "gpt-5",
        favorite: true,
      }),
    ).toEqual({
      favoriteModels: [
        { provider: "claude", modelId: "sonnet" },
        { provider: "codex", modelId: "gpt-5" },
      ],
      initialized: true,
    });
  });

  it("optimistically updates the host-keyed cache and commits the server snapshot", async () => {
    const queryClient = new QueryClient();
    const queryKey = favoriteModelsQueryKey("server-a");
    queryClient.setQueryData(queryKey, { favoriteModels: [], initialized: true });
    const client = createClient({
      setFavoriteModel: vi.fn(async () => ({
        requestId: "set-1",
        favoriteModels: [{ provider: "codex", modelId: "gpt-5" }],
        initialized: true,
      })),
    });

    const mutation = setSyncedFavoriteModel({
      client,
      queryClient,
      queryKey,
      provider: "codex",
      modelId: "gpt-5",
      favorite: true,
    });
    expect(queryClient.getQueryData(queryKey)).toEqual({
      favoriteModels: [{ provider: "codex", modelId: "gpt-5" }],
      initialized: true,
    });
    await mutation;
    expect(queryClient.getQueryData(queryKey)).toEqual({
      favoriteModels: [{ provider: "codex", modelId: "gpt-5" }],
      initialized: true,
    });
    expect(queryClient.getQueryData(favoriteModelsQueryKey("server-b"))).toBeUndefined();
  });

  it("rolls back the optimistic cache when the daemon rejects the mutation", async () => {
    const queryClient = new QueryClient();
    const queryKey = favoriteModelsQueryKey("server-a");
    const previous = {
      favoriteModels: [{ provider: "claude", modelId: "sonnet" }],
      initialized: true,
    };
    queryClient.setQueryData(queryKey, previous);
    const client = createClient({
      setFavoriteModel: vi.fn(async () => {
        throw new Error("write failed");
      }),
    });

    await expect(
      setSyncedFavoriteModel({
        client,
        queryClient,
        queryKey,
        provider: "codex",
        modelId: "gpt-5",
        favorite: true,
      }),
    ).rejects.toThrow("write failed");
    expect(queryClient.getQueryData(queryKey)).toEqual(previous);
  });
});
