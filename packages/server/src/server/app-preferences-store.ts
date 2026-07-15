import { readFile } from "node:fs/promises";
import { z } from "zod";
import {
  FavoriteModelPreferenceSchema,
  type FavoriteModelPreference,
  type FavoriteModelsSnapshot,
} from "@getpaseo/protocol/messages";
import { writeJsonFileAtomic } from "./atomic-file.js";

export const APP_PREFERENCES_FILE_NAME = "app-preferences.json";

const AppPreferencesFileSchema = z
  .object({
    favoriteModels: z.array(FavoriteModelPreferenceSchema),
  })
  .passthrough();

type AppPreferencesListener = (snapshot: FavoriteModelsSnapshot) => void;

function deduplicateFavoriteModels(
  favoriteModels: readonly FavoriteModelPreference[],
): FavoriteModelPreference[] {
  const result: FavoriteModelPreference[] = [];
  for (const favorite of favoriteModels) {
    if (
      result.some(
        (existing) =>
          existing.provider === favorite.provider && existing.modelId === favorite.modelId,
      )
    ) {
      continue;
    }
    result.push({ provider: favorite.provider, modelId: favorite.modelId });
  }
  return result;
}

export class AppPreferencesStore {
  private loaded = false;
  private initialized = false;
  private favoriteModels: FavoriteModelPreference[] = [];
  private mutationQueue: Promise<void> = Promise.resolve();
  private readonly listeners = new Set<AppPreferencesListener>();

  constructor(private readonly filePath: string) {}

  async getFavoriteModels(): Promise<FavoriteModelsSnapshot> {
    await this.mutationQueue;
    await this.load();
    return this.snapshot();
  }

  async initializeFavoriteModels(
    favoriteModels: readonly FavoriteModelPreference[],
  ): Promise<FavoriteModelsSnapshot> {
    const parsed = z.array(FavoriteModelPreferenceSchema).parse(favoriteModels);
    const deduplicated = deduplicateFavoriteModels(parsed);

    return this.serializeMutation(async () => {
      await this.load();
      if (this.initialized || deduplicated.length === 0) {
        return this.snapshot();
      }

      await this.persist(deduplicated);
      this.favoriteModels = deduplicated;
      this.initialized = true;
      return this.publishSnapshot();
    });
  }

  async setFavoriteModel(
    input: FavoriteModelPreference & { favorite: boolean },
  ): Promise<FavoriteModelsSnapshot> {
    const favorite = FavoriteModelPreferenceSchema.parse(input);

    return this.serializeMutation(async () => {
      await this.load();
      const existingIndex = this.favoriteModels.findIndex(
        (entry) => entry.provider === favorite.provider && entry.modelId === favorite.modelId,
      );
      const hasFavorite = existingIndex >= 0;
      const changed = !this.initialized || hasFavorite !== input.favorite;

      if (!changed) {
        return this.snapshot();
      }

      let nextFavoriteModels = this.favoriteModels;
      if (input.favorite && !hasFavorite) {
        nextFavoriteModels = [...this.favoriteModels, favorite];
      } else if (!input.favorite && hasFavorite) {
        nextFavoriteModels = this.favoriteModels.filter((_, index) => index !== existingIndex);
      }
      await this.persist(nextFavoriteModels);
      this.favoriteModels = nextFavoriteModels;
      this.initialized = true;
      return this.publishSnapshot();
    });
  }

  onChange(listener: AppPreferencesListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private async load(): Promise<void> {
    if (this.loaded) {
      return;
    }

    try {
      const content = await readFile(this.filePath, "utf8");
      const stored = AppPreferencesFileSchema.parse(JSON.parse(content));
      this.favoriteModels = deduplicateFavoriteModels(stored.favoriteModels);
      this.initialized = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      this.favoriteModels = [];
      this.initialized = false;
    }
    this.loaded = true;
  }

  private async persist(favoriteModels: FavoriteModelPreference[]): Promise<void> {
    await writeJsonFileAtomic(this.filePath, { favoriteModels });
  }

  private snapshot(): FavoriteModelsSnapshot {
    return {
      favoriteModels: this.favoriteModels.map((favorite) => ({ ...favorite })),
      initialized: this.initialized,
    };
  }

  private publishSnapshot(): FavoriteModelsSnapshot {
    const snapshot = this.snapshot();
    for (const listener of this.listeners) {
      listener(snapshot);
    }
    return snapshot;
  }

  private async serializeMutation<T>(mutation: () => Promise<T>): Promise<T> {
    const next = this.mutationQueue.catch(() => undefined).then(mutation);
    this.mutationQueue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}
