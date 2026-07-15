import { useCallback, useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { FavoriteModelPreference, FavoriteModelsSnapshot } from "@getpaseo/protocol/messages";
import { useToast } from "@/contexts/toast-context";
import { favoriteModelsQueryKey } from "@/data/favorite-models";
import { useReplicaQuery } from "@/data/query";
import { useFormPreferences } from "@/hooks/use-form-preferences";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { toErrorMessage } from "@/utils/error-messages";
import {
  buildFavoriteModelKey,
  toggleFavoriteModel as toggleLocalFavoriteModel,
} from "@/create-agent-preferences/preferences";
import {
  fetchFavoriteModels,
  resolveEffectiveFavoriteModels,
  setSyncedFavoriteModel,
} from "@/hooks/favorite-models";

interface UseFavoriteModelsResult {
  favoriteModels: FavoriteModelPreference[];
  favoriteKeys: Set<string>;
  isLoading: boolean;
  toggleFavoriteModel: (provider: string, modelId: string) => void;
}

export function useFavoriteModels(serverId: string | null): UseFavoriteModelsResult {
  const toast = useToast();
  const queryClient = useQueryClient();
  const {
    preferences,
    isLoading: isLocalPreferencesLoading,
    updatePreferences,
  } = useFormPreferences();
  const supportsSync = useHostFeature(serverId, "favoriteModelsSync");
  const client = useHostRuntimeClient(serverId ?? "");
  const isConnected = useHostRuntimeIsConnected(serverId ?? "");
  const queryKey = useMemo(() => favoriteModelsQueryKey(serverId), [serverId]);
  const legacyFavorites = preferences.favoriteModels ?? [];

  const favoriteModelsQuery = useReplicaQuery({
    queryKey,
    enabled: Boolean(
      supportsSync && serverId && client && isConnected && !isLocalPreferencesLoading,
    ),
    pushEvent: "status:preferences.favorite_models.changed",
    queryFn: async () => {
      if (!client) {
        throw new Error("Host disconnected");
      }
      return fetchFavoriteModels({ client, legacyFavorites });
    },
  });

  const favoriteModels = resolveEffectiveFavoriteModels({
    supportsSync,
    synced: favoriteModelsQuery.data,
    legacy: legacyFavorites,
  });
  const favoriteKeys = useMemo(
    () => new Set(favoriteModels.map((favorite) => buildFavoriteModelKey(favorite))),
    [favoriteModels],
  );

  const toggleFavoriteModel = useCallback(
    (provider: string, modelId: string) => {
      const key = buildFavoriteModelKey({ provider, modelId });
      const syncedFavoriteModels = supportsSync
        ? queryClient.getQueryData<FavoriteModelsSnapshot>(queryKey)?.favoriteModels
        : undefined;
      const favorite = !(syncedFavoriteModels
        ? syncedFavoriteModels.some((entry) => buildFavoriteModelKey(entry) === key)
        : favoriteKeys.has(key));

      if (!supportsSync || !serverId) {
        void updatePreferences((current) =>
          toggleLocalFavoriteModel({ preferences: current, provider, modelId }),
        ).catch((error) => {
          console.warn("[favorite-models] local update failed", error);
          toast.error(toErrorMessage(error));
        });
        return;
      }

      if (!client || !isConnected) {
        toast.error("Host disconnected");
        return;
      }

      void setSyncedFavoriteModel({
        client,
        queryClient,
        queryKey,
        provider,
        modelId,
        favorite,
      }).catch((error) => {
        console.warn("[favorite-models] synced update failed", error);
        toast.error(toErrorMessage(error));
      });
    },
    [
      client,
      favoriteKeys,
      isConnected,
      queryClient,
      queryKey,
      serverId,
      supportsSync,
      toast,
      updatePreferences,
    ],
  );

  return {
    favoriteModels,
    favoriteKeys,
    isLoading: supportsSync ? favoriteModelsQuery.isLoading : isLocalPreferencesLoading,
    toggleFavoriteModel,
  };
}
