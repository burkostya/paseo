import type { Logger } from "pino";
import type { ProviderUsage } from "../../server/messages.js";
import { createProviderUsageFetchers } from "./manifest.js";
import type { ProviderApiFetch, ProviderUsageFetcher } from "./provider.js";
import { unavailableUsage } from "./usage.js";

export interface ProviderUsageServiceOptions {
  logger: Logger;
  fetchers?: ProviderUsageFetcher[];
  fetch?: ProviderApiFetch;
  cacheTtlMs?: number;
  now?: () => number;
}

export interface ProviderUsageListResult {
  fetchedAt: string;
  providers: ProviderUsage[];
}

type ProviderUsageListener = (result: ProviderUsageListResult) => void;

interface CachedProviderUsage {
  fetchedAtMs: number;
  usage: ProviderUsage;
}

interface ProviderFetchResult extends CachedProviderUsage {
  fresh: boolean;
}

const DEFAULT_PROVIDER_USAGE_CACHE_TTL_MS = 5 * 60 * 1000;

export class ProviderUsageService {
  private readonly logger: Logger;
  private readonly fetchers: ProviderUsageFetcher[];
  private readonly fetchersById: Map<string, ProviderUsageFetcher>;
  private readonly cacheTtlMs: number;
  private readonly now: () => number;
  private readonly cached = new Map<string, CachedProviderUsage>();
  private readonly inFlight = new Map<string, Promise<CachedProviderUsage>>();
  private readonly listeners = new Set<ProviderUsageListener>();
  private lastListResult: ProviderUsageListResult | null = null;

  constructor(options: ProviderUsageServiceOptions) {
    this.logger = options.logger.child({ module: "provider-usage-service" });
    this.fetchers =
      options.fetchers ??
      createProviderUsageFetchers({
        logger: this.logger,
        fetch: options.fetch,
      });
    this.fetchersById = new Map(this.fetchers.map((fetcher) => [fetcher.providerId, fetcher]));
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_PROVIDER_USAGE_CACHE_TTL_MS;
    this.now = options.now ?? Date.now;
  }

  onFreshUsage(listener: ProviderUsageListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async listUsage(options?: { forceRefresh?: boolean }): Promise<ProviderUsageListResult> {
    const results = await Promise.all(
      this.fetchers.map((fetcher) =>
        this.getProviderUsage(fetcher, { forceRefresh: options?.forceRefresh === true }),
      ),
    );
    const hasFresh = results.some((entry) => entry.fresh);
    if (!hasFresh && this.lastListResult) return this.lastListResult;
    const result = this.toListResult(results);
    this.lastListResult = result;
    if (hasFresh) {
      this.publish(result);
    }
    return result;
  }

  async refreshProvider(providerId: string): Promise<ProviderUsage | null> {
    const fetcher = this.fetchersById.get(providerId);
    if (!fetcher) return null;
    const result = await this.getProviderUsage(fetcher, { forceRefresh: true });
    this.lastListResult = null;
    this.publish({
      fetchedAt: new Date(result.fetchedAtMs).toISOString(),
      providers: [result.usage],
    });
    return result.usage;
  }

  private async getProviderUsage(
    fetcher: ProviderUsageFetcher,
    options: { forceRefresh: boolean },
  ): Promise<ProviderFetchResult> {
    const nowMs = this.now();
    const cached = this.cached.get(fetcher.providerId);
    if (!options.forceRefresh && cached && nowMs - cached.fetchedAtMs < this.cacheTtlMs) {
      return { ...cached, fresh: false };
    }

    const existing = this.inFlight.get(fetcher.providerId);
    if (existing) {
      return { ...(await existing), fresh: false };
    }

    const request = this.fetchProvider(fetcher, nowMs);
    this.inFlight.set(fetcher.providerId, request);
    try {
      return { ...(await request), fresh: true };
    } finally {
      if (this.inFlight.get(fetcher.providerId) === request) {
        this.inFlight.delete(fetcher.providerId);
      }
    }
  }

  private async fetchProvider(
    fetcher: ProviderUsageFetcher,
    fetchedAtMs: number,
  ): Promise<CachedProviderUsage> {
    let usage: ProviderUsage;
    try {
      usage = await fetcher.fetchUsage();
    } catch (error) {
      this.logger.debug(
        { err: error, providerId: fetcher.providerId },
        "Provider usage fetch failed",
      );
      usage = unavailableUsage({
        providerId: fetcher.providerId,
        displayName: fetcher.displayName,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    const entry = { fetchedAtMs, usage };
    this.cached.set(fetcher.providerId, entry);
    return entry;
  }

  private toListResult(results: readonly CachedProviderUsage[]): ProviderUsageListResult {
    const fetchedAtMs =
      results.length > 0 ? Math.max(...results.map((result) => result.fetchedAtMs)) : this.now();
    return {
      fetchedAt: new Date(fetchedAtMs).toISOString(),
      providers: results.map((result) => result.usage),
    };
  }

  private publish(result: ProviderUsageListResult): void {
    for (const listener of this.listeners) listener(result);
  }
}
