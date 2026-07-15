import type { QueryClient } from "@tanstack/react-query";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { FavoriteModelPreference, FavoriteModelsSnapshot } from "@getpaseo/protocol/messages";
import { buildFavoriteModelKey } from "@/create-agent-preferences/preferences";
import { favoriteModelsQueryKey, type FavoriteModelsCache } from "@/data/favorite-models";

export type FavoriteModelsClient = Pick<
  DaemonClient,
  "getFavoriteModels" | "initializeFavoriteModels" | "setFavoriteModel"
>;

function deduplicateFavorites(
  favorites: readonly FavoriteModelPreference[],
): FavoriteModelPreference[] {
  const seen = new Set<string>();
  return favorites.flatMap((favorite) => {
    if (!favorite.provider) {
      return [];
    }
    const key = buildFavoriteModelKey(favorite);
    if (seen.has(key)) {
      return [];
    }
    seen.add(key);
    return [{ ...favorite }];
  });
}

function toFavoriteModelsSnapshot(snapshot: FavoriteModelsSnapshot): FavoriteModelsSnapshot {
  return {
    favoriteModels: snapshot.favoriteModels,
    initialized: snapshot.initialized,
  };
}

export async function fetchFavoriteModels(input: {
  client: FavoriteModelsClient;
  legacyFavorites: readonly FavoriteModelPreference[];
}): Promise<FavoriteModelsSnapshot> {
  const current = await input.client.getFavoriteModels();
  if (current.initialized) {
    return toFavoriteModelsSnapshot(current);
  }

  const legacyFavorites = deduplicateFavorites(input.legacyFavorites);
  if (legacyFavorites.length === 0) {
    return toFavoriteModelsSnapshot(current);
  }
  return toFavoriteModelsSnapshot(await input.client.initializeFavoriteModels(legacyFavorites));
}

export function setFavoriteInSnapshot(input: {
  snapshot: FavoriteModelsSnapshot | undefined;
  provider: string;
  modelId: string;
  favorite: boolean;
}): FavoriteModelsSnapshot {
  const existing = input.snapshot?.favoriteModels ?? [];
  const key = buildFavoriteModelKey({ provider: input.provider, modelId: input.modelId });
  const withoutTarget = existing.filter((favorite) => buildFavoriteModelKey(favorite) !== key);
  return {
    favoriteModels: input.favorite
      ? [...withoutTarget, { provider: input.provider, modelId: input.modelId }]
      : withoutTarget,
    initialized: true,
  };
}

export async function setSyncedFavoriteModel(input: {
  client: FavoriteModelsClient;
  queryClient: QueryClient;
  queryKey: ReturnType<typeof favoriteModelsQueryKey>;
  provider: string;
  modelId: string;
  favorite: boolean;
}): Promise<void> {
  const previous = input.queryClient.getQueryData<FavoriteModelsCache>(input.queryKey);
  input.queryClient.setQueryData<FavoriteModelsCache>(
    input.queryKey,
    setFavoriteInSnapshot({
      snapshot: previous,
      provider: input.provider,
      modelId: input.modelId,
      favorite: input.favorite,
    }),
  );

  try {
    const result = await input.client.setFavoriteModel({
      provider: input.provider,
      modelId: input.modelId,
      favorite: input.favorite,
    });
    input.queryClient.setQueryData<FavoriteModelsCache>(
      input.queryKey,
      toFavoriteModelsSnapshot(result),
    );
  } catch (error) {
    input.queryClient.setQueryData<FavoriteModelsCache>(input.queryKey, previous);
    throw error;
  }
}

export function resolveEffectiveFavoriteModels(input: {
  supportsSync: boolean;
  synced: FavoriteModelsSnapshot | undefined;
  legacy: readonly FavoriteModelPreference[];
}): FavoriteModelPreference[] {
  return input.supportsSync ? (input.synced?.favoriteModels ?? []) : [...input.legacy];
}
