import type { FavoriteModelsSnapshot } from "@getpaseo/protocol/messages";

export type FavoriteModelsCache = FavoriteModelsSnapshot;

export function favoriteModelsQueryKey(serverId: string | null) {
  return ["favorite-models", serverId] as const;
}
