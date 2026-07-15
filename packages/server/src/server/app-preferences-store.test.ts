import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AppPreferencesStore } from "./app-preferences-store.js";

const temporaryDirectories: string[] = [];

async function createStore(): Promise<{
  dir: string;
  filePath: string;
  store: AppPreferencesStore;
}> {
  const dir = await mkdtemp(join(tmpdir(), "paseo-app-preferences-"));
  temporaryDirectories.push(dir);
  const filePath = join(dir, "app-preferences.json");
  return { dir, filePath, store: new AppPreferencesStore(filePath) };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("AppPreferencesStore", () => {
  it("distinguishes an absent file from an initialized empty list", async () => {
    const { filePath, store } = await createStore();

    await expect(store.getFavoriteModels()).resolves.toEqual({
      favoriteModels: [],
      initialized: false,
    });

    await store.setFavoriteModel({ provider: "codex", modelId: "gpt-5", favorite: false });

    await expect(new AppPreferencesStore(filePath).getFavoriteModels()).resolves.toEqual({
      favoriteModels: [],
      initialized: true,
    });
  });

  it("initializes once from the first non-empty deduplicated legacy list", async () => {
    const { store } = await createStore();
    const changes: unknown[] = [];
    store.onChange((snapshot) => changes.push(snapshot));

    await expect(store.initializeFavoriteModels([])).resolves.toEqual({
      favoriteModels: [],
      initialized: false,
    });
    await expect(
      store.initializeFavoriteModels([
        { provider: "codex", modelId: "gpt-5" },
        { provider: "codex", modelId: "gpt-5" },
        { provider: "claude", modelId: "" },
      ]),
    ).resolves.toEqual({
      favoriteModels: [
        { provider: "codex", modelId: "gpt-5" },
        { provider: "claude", modelId: "" },
      ],
      initialized: true,
    });
    await expect(
      store.initializeFavoriteModels([{ provider: "pi", modelId: "other" }]),
    ).resolves.toEqual({
      favoriteModels: [
        { provider: "codex", modelId: "gpt-5" },
        { provider: "claude", modelId: "" },
      ],
      initialized: true,
    });
    expect(changes).toHaveLength(1);
  });

  it("persists idempotent add and remove operations, including an empty authoritative list", async () => {
    const { filePath, store } = await createStore();
    const changes: unknown[] = [];
    store.onChange((snapshot) => changes.push(snapshot));

    await store.setFavoriteModel({ provider: "codex", modelId: "gpt-5", favorite: true });
    await store.setFavoriteModel({ provider: "codex", modelId: "gpt-5", favorite: true });
    await store.setFavoriteModel({ provider: "codex", modelId: "gpt-5", favorite: false });
    await store.setFavoriteModel({ provider: "codex", modelId: "gpt-5", favorite: false });

    expect(changes).toHaveLength(2);
    expect(JSON.parse(await readFile(filePath, "utf8"))).toEqual({ favoriteModels: [] });
    await expect(new AppPreferencesStore(filePath).getFavoriteModels()).resolves.toEqual({
      favoriteModels: [],
      initialized: true,
    });
  });

  it("serializes concurrent mutations without losing distinct favorites", async () => {
    const { store } = await createStore();

    await Promise.all([
      store.setFavoriteModel({ provider: "codex", modelId: "gpt-5", favorite: true }),
      store.setFavoriteModel({ provider: "claude", modelId: "sonnet", favorite: true }),
      store.setFavoriteModel({ provider: "pi", modelId: "", favorite: true }),
    ]);

    await expect(store.getFavoriteModels()).resolves.toEqual({
      favoriteModels: [
        { provider: "codex", modelId: "gpt-5" },
        { provider: "claude", modelId: "sonnet" },
        { provider: "pi", modelId: "" },
      ],
      initialized: true,
    });
  });
});
