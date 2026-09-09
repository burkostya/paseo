import { chmodSync, existsSync, readFileSync, readdirSync, statSync, unlinkSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

import {
  AgentProviderRuntimeSettingsMapSchema,
  migrateProviderSettings,
  ProviderOverridesSchema,
} from "./agent/provider-launch-config.js";
import type { AgentProviderRuntimeSettingsMap } from "./agent/provider-launch-config.js";
import { ensurePrivateFile, writePrivateFileAtomicSync } from "./private-files.js";
import {
  AgentProfileSchema,
  AgentSkillSelectionSchema,
  IssueTrackerConfigSchema,
  PluginIdSchema,
  PluginSourceSchema,
  TerminalProfileSchema,
} from "@getpaseo/protocol/messages";
import { PaseoServicePortAllocationSchema } from "@getpaseo/protocol/paseo-config-schema";

export const LogLevelSchema = z.enum(["trace", "debug", "info", "warn", "error", "fatal"]);
export const LogFormatSchema = z.enum(["pretty", "json"]);

const LogConfigSchema = z
  .object({
    // Legacy global log settings (kept for backwards compatibility).
    level: LogLevelSchema.optional(),
    format: LogFormatSchema.optional(),

    console: z
      .object({
        level: LogLevelSchema.optional(),
        format: LogFormatSchema.optional(),
      })
      .strict()
      .optional(),

    file: z
      .object({
        level: LogLevelSchema.optional(),
        path: z.string().min(1).optional(),
        rotate: z
          .object({
            maxSize: z.string().min(1).optional(),
            maxFiles: z.number().int().positive().optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const OpenAiSpeechEndpointSchema = z
  .object({
    apiKey: z.string().trim().min(1).optional(),
    baseUrl: z.string().trim().min(1).optional(),
  })
  .strict();

const OpenAiProviderSchema = z
  .object({
    apiKey: z.string().min(1).optional(),
    baseUrl: z.string().trim().min(1).optional(),
    stt: OpenAiSpeechEndpointSchema.optional(),
    tts: OpenAiSpeechEndpointSchema.optional(),
  })
  .strict();

const LocalSpeechProviderSchema = z
  .object({
    modelsDir: z.string().min(1).optional(),
  })
  .strict();

const ProvidersSchema = z
  .object({
    openai: OpenAiProviderSchema.optional(),
    local: LocalSpeechProviderSchema.optional(),
  })
  .strict();

const WorktreesConfigSchema = z
  .object({
    root: z.string().min(1).optional(),
    servicePorts: PaseoServicePortAllocationSchema.optional(),
  })
  .strict();

const BcryptHashSchema = z.string().regex(/^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/, {
  message: "Expected a bcrypt hash",
});

const DaemonAuthSchema = z
  .object({
    password: BcryptHashSchema.optional(),
  })
  .strict();

const SpeechProviderIdSchema = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.enum(["openai", "local"]));

const FeatureDictationSchema = z
  .object({
    enabled: z.boolean().optional(),
    stt: z
      .object({
        provider: SpeechProviderIdSchema.optional(),
        model: z.string().min(1).optional(),
        language: z.string().trim().min(1).optional(),
        confidenceThreshold: z.number().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const FeatureVoiceModeSchema = z
  .object({
    enabled: z.boolean().optional(),
    llm: z
      .object({
        provider: z.string().optional(),
        model: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
    stt: z
      .object({
        provider: SpeechProviderIdSchema.optional(),
        model: z.string().min(1).optional(),
        language: z.string().trim().min(1).optional(),
      })
      .strict()
      .optional(),
    turnDetection: z
      .object({
        provider: SpeechProviderIdSchema.optional(),
      })
      .strict()
      .optional(),
    tts: z
      .object({
        provider: SpeechProviderIdSchema.optional(),
        model: z.string().min(1).optional(),
        voice: z.enum(["alloy", "echo", "fable", "onyx", "nova", "shimmer"]).optional(),
        speakerId: z.number().int().optional(),
        speed: z.number().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const FeatureWebUiSchema = z
  .object({
    enabled: z.boolean().optional(),
    distDir: z.string().min(1).optional(),
  })
  .strict();

const StructuredGenerationProviderConfigSchema = z
  .object({
    provider: z.string().min(1),
    model: z.string().min(1).optional(),
    thinkingOptionId: z.string().min(1).optional(),
  })
  .strict();

const AgentMetadataGenerationSchema = z
  .object({
    providers: z.array(StructuredGenerationProviderConfigSchema).optional(),
  })
  .strict();

const BUILTIN_PROVIDER_IDS = ["claude", "codex", "copilot", "opencode", "pi", "omp"] as const;

function isLegacyProviderEntry(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const command = (value as Record<string, unknown>).command;
  if (!command || typeof command !== "object" || Array.isArray(command)) {
    return false;
  }

  return typeof (command as Record<string, unknown>).mode === "string";
}

function normalizeAgentProviders(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }

  const rawProviders = value as Record<string, unknown>;
  const hasLegacyEntries = Object.values(rawProviders).some((entry) =>
    isLegacyProviderEntry(entry),
  );
  if (!hasLegacyEntries) {
    return value;
  }

  const legacyEntries: Record<string, unknown> = {};
  const normalizedEntries: Record<string, unknown> = {};

  for (const [providerId, providerValue] of Object.entries(rawProviders)) {
    if (isLegacyProviderEntry(providerValue)) {
      legacyEntries[providerId] = providerValue;
      continue;
    }
    normalizedEntries[providerId] = providerValue;
  }

  const parsedLegacyEntries = AgentProviderRuntimeSettingsMapSchema.safeParse(legacyEntries);
  if (!parsedLegacyEntries.success) {
    return value;
  }

  return {
    ...normalizedEntries,
    ...migrateProviderSettings(parsedLegacyEntries.data, [...BUILTIN_PROVIDER_IDS]),
  };
}

export const PersistedConfigSchema = z
  .object({
    $schema: z.string().optional(),

    // v1 schema marker
    version: z.literal(1).optional(),

    // v1 config layout
    daemon: z
      .object({
        listen: z.string().optional(),
        hostnames: z.union([z.literal(true), z.array(z.string())]).optional(),
        allowedHosts: z.union([z.literal(true), z.array(z.string())]).optional(),
        trustedProxies: z.union([z.literal(true), z.array(z.string())]).optional(),
        mcp: z
          .object({
            enabled: z.boolean().optional(),
            injectIntoAgents: z.boolean().optional(),
          })
          .passthrough()
          .optional(),
        browserTools: z
          .object({
            enabled: z.boolean().optional(),
          })
          .passthrough()
          .optional(),
        git: z
          .object({
            maxProcessesPerSecond: z.number().int().positive().optional(),
            maxProcessConcurrency: z.number().int().positive().optional(),
          })
          .strict()
          .optional(),
        autoArchiveAfterMerge: z.boolean().optional(),
        enableTerminalAgentHooks: z.boolean().optional(),
        appendSystemPrompt: z.string().optional(),
        terminalProfiles: z.array(TerminalProfileSchema).optional(),
        agentProfiles: z.array(AgentProfileSchema).optional(),
        issueTrackers: z.array(IssueTrackerConfigSchema).optional(),
        cors: z
          .object({
            allowedOrigins: z.array(z.string()).optional(),
          })
          .strict()
          .optional(),
        relay: z
          .object({
            enabled: z.boolean().optional(),
            endpoint: z.string().optional(),
            publicEndpoint: z.string().optional(),
            useTls: z.boolean().optional(),
            publicUseTls: z.boolean().optional(),
          })
          .strict()
          .optional(),
        serviceProxy: z
          .object({
            // COMPAT(serviceProxyEnabled): added 2026-06-02, remove after 2026-12-02.
            // Parsed only to suppress optional public/listen layers for old configs;
            // localhost service proxying remains always enabled.
            enabled: z.boolean().optional(),
            listen: z.string().optional(),
            publicBaseUrl: z.url().optional(),
          })
          .strict()
          .optional(),
        auth: DaemonAuthSchema.optional(),
      })
      .strict()
      .transform(({ allowedHosts, ...daemon }) => {
        const hostnames = daemon.hostnames ?? allowedHosts;
        return hostnames === undefined ? daemon : { ...daemon, hostnames };
      })
      .optional(),

    app: z
      .object({
        baseUrl: z.string().optional(),
      })
      .strict()
      .optional(),

    providers: ProvidersSchema.optional(),
    pluginsEnabled: z.boolean().optional(),
    plugins: z.record(PluginIdSchema, PluginSourceSchema).optional(),
    worktrees: WorktreesConfigSchema.optional(),
    agents: z
      .object({
        providers: z.preprocess(normalizeAgentProviders, ProviderOverridesSchema).optional(),
        catalogRefreshTimeoutMs: z.number().int().positive().max(2_147_483_647).optional(),
        metadataGeneration: AgentMetadataGenerationSchema.optional(),
        skills: z.object({ selection: AgentSkillSelectionSchema.optional() }).strict().optional(),
      })
      .strict()
      .optional(),
    features: z
      .object({
        dictation: FeatureDictationSchema.optional(),
        voiceMode: FeatureVoiceModeSchema.optional(),
        webUi: FeatureWebUiSchema.optional(),
      })
      .strict()
      .optional(),

    log: LogConfigSchema.optional(),
  })
  .strict();

type PersistedConfigSchemaOutput = z.infer<typeof PersistedConfigSchema>;

export type PersistedConfig = Omit<PersistedConfigSchemaOutput, "agents"> & {
  agents?: Omit<NonNullable<PersistedConfigSchemaOutput["agents"]>, "providers"> & {
    providers?: AgentProviderRuntimeSettingsMap;
  };
};

const CONFIG_FILENAME = "config.json";
const CONFIG_LOCAL_FILENAME = "config.local.json";
const CONFIG_FRAGMENTS_DIRECTORY = "conf.d";
const DEFAULT_PERSISTED_CONFIG = PersistedConfigSchema.parse({
  version: 1,
  daemon: {
    listen: "127.0.0.1:6767",
    cors: {
      allowedOrigins: ["https://app.paseo.sh"],
    },
    relay: {
      enabled: false,
    },
  },
  app: {
    baseUrl: "https://app.paseo.sh",
  },
}) as PersistedConfig;

interface LoggerLike {
  child(bindings: Record<string, unknown>): LoggerLike;
  info(...args: unknown[]): void;
}

function getConfigPath(paseoHome: string): string {
  return path.join(paseoHome, CONFIG_FILENAME);
}

function getConfigLocalPath(paseoHome: string): string {
  return path.join(paseoHome, CONFIG_LOCAL_FILENAME);
}

function getConfigFragmentsPath(paseoHome: string): string {
  return path.join(paseoHome, CONFIG_FRAGMENTS_DIRECTORY);
}

function getLogger(logger: LoggerLike | undefined): LoggerLike | undefined {
  return logger?.child({ module: "config" });
}

type JsonObject = Record<string, unknown>;

export interface PersistedConfigWriteState {
  path: string;
  layered?: boolean;
  existed: boolean;
  contents?: string;
  mode?: number;
}

interface PersistedConfigLayers {
  lower: PersistedConfig;
  effective: PersistedConfig;
  localOverride?: JsonObject;
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(cloneJsonValue);
  }
  if (isJsonObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, cloneJsonValue(entry)]),
    );
  }
  return value;
}

function mergeConfigLayer(base: JsonObject, overlay: JsonObject): JsonObject {
  const result = cloneJsonValue(base) as JsonObject;

  for (const [key, value] of Object.entries(overlay)) {
    if (value === null) {
      delete result[key];
      if (key === "hostnames") delete result.allowedHosts;
      if (key === "allowedHosts") delete result.hostnames;
      continue;
    }

    if (isJsonObject(result[key]) && isJsonObject(value)) {
      result[key] = mergeConfigLayer(result[key] as JsonObject, value);
      continue;
    }

    result[key] = cloneJsonValue(value);
  }

  return result;
}

function formatConfigIssues(error: z.ZodError): string {
  return error.issues.map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`).join("\n");
}

function parseConfigDocument(filePath: string, repairPermissions: boolean): JsonObject {
  let raw: string;
  try {
    if (repairPermissions) {
      ensurePrivateFile(filePath);
    }
    raw = readFileSync(filePath, "utf-8");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`[Config] Failed to read ${filePath}: ${message}`, {
      cause: err,
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`[Config] Invalid JSON in ${filePath}: ${message}`, {
      cause: err,
    });
  }

  if (!isJsonObject(parsed)) {
    throw new Error(`[Config] Invalid config in ${filePath}: expected a JSON object`);
  }

  return normalizeConfigAliases(stripRemovedConfigFields(parsed) as JsonObject);
}

function normalizeConfigAliases(document: JsonObject): JsonObject {
  const daemon = document.daemon;
  if (!isJsonObject(daemon) || !hasOwn(daemon, "allowedHosts")) {
    return document;
  }

  const normalizedDaemon = { ...daemon };
  if (!hasOwn(normalizedDaemon, "hostnames")) {
    normalizedDaemon.hostnames = normalizedDaemon.allowedHosts;
  }
  delete normalizedDaemon.allowedHosts;
  return { ...document, daemon: normalizedDaemon };
}

function parseMergedConfig(value: JsonObject, source: string): PersistedConfig {
  const result = PersistedConfigSchema.safeParse(stripRemovedConfigFields(value));
  if (!result.success) {
    throw new Error(
      `[Config] Invalid config after merging ${source}:\n${formatConfigIssues(result.error)}`,
    );
  }
  return result.data as PersistedConfig;
}

function isConfigLayeringEnabled(paseoHome: string): boolean {
  const fragmentsPath = getConfigFragmentsPath(paseoHome);
  try {
    return statSync(fragmentsPath).isDirectory();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`[Config] Failed to inspect ${fragmentsPath}: ${message}`, {
      cause: err,
    });
  }
}

function listConfigFragments(paseoHome: string): string[] {
  const fragmentsDirectory = getConfigFragmentsPath(paseoHome);
  let entries: string[];
  try {
    entries = readdirSync(fragmentsDirectory);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `[Config] Failed to read config fragments in ${fragmentsDirectory}: ${message}`,
      {
        cause: err,
      },
    );
  }

  return entries
    .filter((entry) => entry.endsWith(".json"))
    .sort()
    .flatMap((entry) => {
      const filePath = path.join(fragmentsDirectory, entry);
      try {
        return statSync(filePath).isFile() ? [filePath] : [];
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`[Config] Failed to inspect ${filePath}: ${message}`, {
          cause: err,
        });
      }
    });
}

function readConfigLayers(paseoHome: string, logger?: LoggerLike): PersistedConfigLayers {
  const log = getLogger(logger);
  const configPath = getConfigPath(paseoHome);
  const layered = isConfigLayeringEnabled(paseoHome);

  if (!layered) {
    if (!existsSync(configPath)) {
      try {
        writePrivateFileAtomicSync(
          configPath,
          JSON.stringify(DEFAULT_PERSISTED_CONFIG, null, 2) + "\n",
        );
        log?.info(`Initialized config file at ${configPath}`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`[Config] Failed to initialize ${configPath}: ${message}`, { cause: err });
      }
    }

    const document = parseConfigDocument(configPath, true);
    const config = parseMergedConfig(document, configPath);
    log?.info(`Loaded from ${configPath}`);
    return { lower: config, effective: config };
  }

  let lowerDocument: JsonObject;
  const lowerSources: string[] = [];
  if (existsSync(configPath)) {
    lowerDocument = parseConfigDocument(configPath, false);
    lowerSources.push(configPath);
  } else {
    lowerDocument = cloneJsonValue(DEFAULT_PERSISTED_CONFIG) as JsonObject;
  }

  const fragmentPaths = listConfigFragments(paseoHome);
  lowerSources.push(...fragmentPaths);
  for (const fragmentPath of fragmentPaths) {
    lowerDocument = mergeConfigLayer(lowerDocument, parseConfigDocument(fragmentPath, false));
  }

  const lower = parseMergedConfig(
    lowerDocument,
    lowerSources.length > 0 ? lowerSources.join(", ") : "defaults",
  );

  const localPath = getConfigLocalPath(paseoHome);
  const localOverride = existsSync(localPath) ? parseConfigDocument(localPath, true) : undefined;
  const effectiveDocument = localOverride
    ? mergeConfigLayer(lowerDocument, localOverride)
    : lowerDocument;
  const effective = parseMergedConfig(effectiveDocument, localPath);
  log?.info(
    `Loaded config layers from ${configPath} (${fragmentPaths.length} fragment${fragmentPaths.length === 1 ? "" : "s"}${existsSync(localPath) ? ", local override" : ""})`,
  );
  return { lower, effective, localOverride };
}

function hasOwn(value: JsonObject, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isEqualJsonValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((entry, index) => isEqualJsonValue(entry, right[index]));
  }
  if (isJsonObject(left) || isJsonObject(right)) {
    if (!isJsonObject(left) || !isJsonObject(right)) return false;
    // `undefined` object properties are omitted by JSON serialization. Treat
    // them as absent so schema output and a reloaded JSON document compare the
    // same way.
    const leftKeys = Object.keys(left).filter((key) => left[key] !== undefined);
    const rightKeys = Object.keys(right).filter((key) => right[key] !== undefined);
    if (leftKeys.length !== rightKeys.length) return false;
    return leftKeys.every((key) => hasOwn(right, key) && isEqualJsonValue(left[key], right[key]));
  }
  return false;
}

function createConfigOverride(base: JsonObject, desired: JsonObject): JsonObject {
  const override: JsonObject = {};
  const keys = new Set([...Object.keys(base), ...Object.keys(desired)]);

  for (const key of keys) {
    // Zod preserves explicitly supplied `undefined` properties. They are
    // omitted by JSON serialization and must behave like absent keys when we
    // compute a JSON override.
    const baseHasKey = hasOwn(base, key) && base[key] !== undefined;
    const desiredHasKey = hasOwn(desired, key) && desired[key] !== undefined;
    if (!desiredHasKey) {
      if (baseHasKey) override[key] = null;
      continue;
    }
    if (!baseHasKey) {
      override[key] = cloneJsonValue(desired[key]);
      continue;
    }

    const baseValue = base[key];
    const desiredValue = desired[key];
    if (isJsonObject(baseValue) && isJsonObject(desiredValue)) {
      const nested = createConfigOverride(baseValue, desiredValue);
      if (Object.keys(nested).length > 0) override[key] = nested;
      continue;
    }
    if (!isEqualJsonValue(baseValue, desiredValue)) {
      override[key] = cloneJsonValue(desiredValue);
    }
  }

  return override;
}

function applyConfigOverride(
  current: JsonObject,
  override: JsonObject,
  lower: JsonObject,
): JsonObject {
  const result = cloneJsonValue(current) as JsonObject;

  for (const [key, value] of Object.entries(override)) {
    if (value === null) {
      if (hasOwn(lower, key)) {
        result[key] = null;
      } else {
        delete result[key];
      }
      continue;
    }

    if (isJsonObject(value)) {
      const nestedCurrent = isJsonObject(result[key]) ? (result[key] as JsonObject) : {};
      const nestedLower = isJsonObject(lower[key]) ? (lower[key] as JsonObject) : {};
      const nestedResult = applyConfigOverride(nestedCurrent, value, nestedLower);
      if (Object.keys(nestedResult).length > 0 && !isEqualJsonValue(nestedResult, lower[key])) {
        result[key] = nestedResult;
      } else {
        delete result[key];
      }
      continue;
    }

    if (hasOwn(lower, key) && isEqualJsonValue(value, lower[key])) {
      delete result[key];
    } else {
      result[key] = cloneJsonValue(value);
    }
  }

  return result;
}

// Removed config fields are stripped before parsing so the strict schema does not
// reject a config written by an older release. The stripped values are discarded,
// not migrated — there is no back-compat for the removed `providers.openai.voice`
// block (use `providers.openai.stt` / `providers.openai.tts`).
function stripRemovedConfigFields(parsed: unknown): unknown {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return parsed;
  }

  const root = { ...(parsed as Record<string, unknown>) };
  const providers = root.providers;
  if (!providers || typeof providers !== "object" || Array.isArray(providers)) {
    return root;
  }

  const providersRecord = { ...(providers as Record<string, unknown>) };

  const local = providersRecord.local;
  if (local && typeof local === "object" && !Array.isArray(local)) {
    const localRecord = { ...(local as Record<string, unknown>) };
    delete localRecord.autoDownload;
    providersRecord.local = localRecord;
  }

  const openai = providersRecord.openai;
  if (openai && typeof openai === "object" && !Array.isArray(openai)) {
    const openaiRecord = { ...(openai as Record<string, unknown>) };
    // COMPAT(openaiVoiceConfig): added 2026-06-30, remove after 2026-12-30.
    // Drop a `providers.openai.voice` block left by an older release so the strict
    // schema doesn't reject it. The value is discarded, not migrated — there is no
    // back-compat; configure `providers.openai.stt` / `providers.openai.tts` instead.
    delete openaiRecord.voice;
    providersRecord.openai = openaiRecord;
  }

  root.providers = providersRecord;
  return root;
}

export function loadPersistedConfig(paseoHome: string, logger?: LoggerLike): PersistedConfig {
  return readConfigLayers(paseoHome, logger).effective;
}

export function savePersistedConfig(
  paseoHome: string,
  config: PersistedConfig,
  logger?: LoggerLike,
): string {
  const log = getLogger(logger);
  const result = PersistedConfigSchema.safeParse(config);
  if (!result.success) {
    throw new Error(`[Config] Invalid config to save:\n${formatConfigIssues(result.error)}`);
  }

  const configPath = getConfigPath(paseoHome);
  if (isConfigLayeringEnabled(paseoHome)) {
    const localPath = getConfigLocalPath(paseoHome);
    const layers = readConfigLayers(paseoHome, logger);
    const requestedOverride = createConfigOverride(
      layers.effective as unknown as JsonObject,
      result.data as unknown as JsonObject,
    );
    let override = applyConfigOverride(
      layers.localOverride ?? {},
      requestedOverride,
      layers.lower as unknown as JsonObject,
    );
    const lowerDocument = layers.lower as unknown as JsonObject;
    let candidate = parseMergedConfig(mergeConfigLayer(lowerDocument, override), localPath);
    if (!isEqualJsonValue(candidate, result.data)) {
      override = applyConfigOverride(
        override,
        createConfigOverride(
          candidate as unknown as JsonObject,
          result.data as unknown as JsonObject,
        ),
        lowerDocument,
      );
      candidate = parseMergedConfig(mergeConfigLayer(lowerDocument, override), localPath);
      if (!isEqualJsonValue(candidate, result.data)) {
        throw new Error(`[Config] Failed to resolve local override ${localPath}`);
      }
    }

    try {
      if (Object.keys(override).length === 0) {
        unlinkSync(localPath);
      } else {
        writePrivateFileAtomicSync(localPath, JSON.stringify(override, null, 2) + "\n");
      }
      log?.info(`Saved local config override to ${localPath}`);
      return localPath;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT" && Object.keys(override).length === 0) {
        log?.info(`Local config override already absent at ${localPath}`);
        return localPath;
      }
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`[Config] Failed to write ${localPath}: ${message}`, {
        cause: err,
      });
    }
  }

  try {
    writePrivateFileAtomicSync(configPath, JSON.stringify(result.data, null, 2) + "\n");
    log?.info(`Saved to ${configPath}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`[Config] Failed to write ${configPath}: ${message}`, {
      cause: err,
    });
  }
  return configPath;
}

export function capturePersistedConfigWriteState(paseoHome: string): PersistedConfigWriteState {
  const layered = isConfigLayeringEnabled(paseoHome);
  const configPath = layered ? getConfigLocalPath(paseoHome) : getConfigPath(paseoHome);
  if (!existsSync(configPath)) {
    return { path: configPath, layered, existed: false };
  }

  try {
    return {
      path: configPath,
      layered,
      existed: true,
      contents: readFileSync(configPath, "utf-8"),
      mode: statSync(configPath).mode & 0o777,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`[Config] Failed to snapshot ${configPath}: ${message}`, {
      cause: err,
    });
  }
}

export function restorePersistedConfigWriteState(state: PersistedConfigWriteState): void {
  if (!state.existed) {
    try {
      unlinkSync(state.path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
    return;
  }

  writePrivateFileAtomicSync(state.path, state.contents ?? "");
  if (state.mode !== undefined && process.platform !== "win32") {
    chmodSync(state.path, state.mode);
  }
}
