import { readFile } from "node:fs/promises";
import type { Logger } from "pino";
import { z } from "zod";
import {
  ProviderUsageAlertSchema,
  type ProviderUsage,
  type ProviderUsageAlert,
} from "../../server/messages.js";
import { writeJsonFileAtomic } from "../../server/atomic-file.js";
import type { ProviderUsageListResult, ProviderUsageService } from "./service.js";

export const PROVIDER_USAGE_ALERTS_FILE_NAME = "provider-usage-alerts.json";
export const PROVIDER_USAGE_MONITOR_INTERVAL_MS = 15 * 60 * 1000;
export const PROVIDER_USAGE_TURN_DEBOUNCE_MS = 5_000;

const ALERT_THRESHOLDS = [75, 90, 95] as const;
const MONITORED_WINDOW_MINUTES = new Set([300, 10_080]);

const AlertCursorSchema = z.object({
  providerId: z.string(),
  windowId: z.string(),
  windowMinutes: z.number(),
  thresholdPct: z.number(),
  resetsAt: z.string().nullable(),
  lastUsedPct: z.number(),
});

const AlertMonitorFileSchema = z
  .object({
    alerts: z.array(ProviderUsageAlertSchema).optional().default([]),
    cursors: z.array(AlertCursorSchema).optional().default([]),
  })
  .passthrough();

type AlertCursor = z.infer<typeof AlertCursorSchema>;

export interface ProviderUsageAlertSnapshot {
  alerts: ProviderUsageAlert[];
  newlyCrossed: ProviderUsageAlert[];
}

type AlertListener = (snapshot: ProviderUsageAlertSnapshot) => void;

function alertKey(input: { providerId: string; windowId: string; windowMinutes: number }): string {
  return `${input.providerId}\u0000${input.windowId}\u0000${input.windowMinutes}`;
}

function highestThreshold(usedPct: number): number | null {
  let result: number | null = null;
  for (const threshold of ALERT_THRESHOLDS) {
    if (usedPct >= threshold) result = threshold;
  }
  return result;
}

function parseTimestamp(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isSameCycle(cursor: AlertCursor, resetsAt: string | null, nowMs: number): boolean {
  if (cursor.resetsAt === resetsAt) return true;
  const previousResetMs = parseTimestamp(cursor.resetsAt);
  if (previousResetMs !== null && previousResetMs <= nowMs) return false;
  // Some rolling-window APIs move their future reset timestamp on every read.
  // A future timestamp change alone must not re-arm already delivered thresholds.
  return true;
}

function cloneAlert(alert: ProviderUsageAlert): ProviderUsageAlert {
  return { ...alert };
}

export class ProviderUsageAlertStore {
  constructor(private readonly filePath: string) {}

  async load(): Promise<{ alerts: ProviderUsageAlert[]; cursors: AlertCursor[] }> {
    try {
      const parsed = AlertMonitorFileSchema.parse(
        JSON.parse(await readFile(this.filePath, "utf8")),
      );
      return {
        alerts: parsed.alerts.map(cloneAlert),
        cursors: parsed.cursors.map((cursor) => Object.assign({}, cursor)),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { alerts: [], cursors: [] };
      }
      throw error;
    }
  }

  async save(state: { alerts: ProviderUsageAlert[]; cursors: AlertCursor[] }): Promise<void> {
    await writeJsonFileAtomic(this.filePath, state);
  }
}

export class ProviderUsageAlertMonitor {
  private readonly logger: Logger;
  private readonly listeners = new Set<AlertListener>();
  private readonly providerRefreshTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private alerts = new Map<string, ProviderUsageAlert>();
  private cursors = new Map<string, AlertCursor>();
  private interval: ReturnType<typeof setInterval> | null = null;
  private unsubscribeUsage: (() => void) | null = null;
  private evaluationQueue: Promise<void> = Promise.resolve();
  private startPromise: Promise<void> | null = null;
  private stopped = false;

  constructor(
    private readonly options: {
      logger: Logger;
      usageService: ProviderUsageService;
      store: ProviderUsageAlertStore;
      now?: () => number;
    },
  ) {
    this.logger = options.logger.child({ module: "provider-usage-alert-monitor" });
  }

  start(): Promise<void> {
    this.startPromise ??= this.startInternal();
    return this.startPromise;
  }

  async getAlerts(): Promise<ProviderUsageAlert[]> {
    await this.start();
    await this.evaluationQueue;
    return this.snapshotAlerts();
  }

  onChange(listener: AlertListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  scheduleProviderRefresh(providerId: string): void {
    if (this.stopped || this.providerRefreshTimers.has(providerId)) return;
    const timer = setTimeout(() => {
      this.providerRefreshTimers.delete(providerId);
      void this.options.usageService.refreshProvider(providerId).catch((error) => {
        this.logger.debug({ err: error, providerId }, "Post-turn provider usage refresh failed");
      });
    }, PROVIDER_USAGE_TURN_DEBOUNCE_MS);
    timer.unref?.();
    this.providerRefreshTimers.set(providerId, timer);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.unsubscribeUsage?.();
    this.unsubscribeUsage = null;
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
    for (const timer of this.providerRefreshTimers.values()) clearTimeout(timer);
    this.providerRefreshTimers.clear();
    await this.evaluationQueue.catch(() => undefined);
  }

  private async startInternal(): Promise<void> {
    let stored: { alerts: ProviderUsageAlert[]; cursors: AlertCursor[] };
    try {
      stored = await this.options.store.load();
    } catch (error) {
      this.logger.warn({ err: error }, "Failed to load provider usage alert state");
      stored = { alerts: [], cursors: [] };
    }
    this.alerts = new Map(stored.alerts.map((alert) => [alertKey(alert), alert]));
    this.cursors = new Map(stored.cursors.map((cursor) => [alertKey(cursor), cursor]));
    this.unsubscribeUsage = this.options.usageService.onFreshUsage((result) => {
      this.enqueueEvaluation(result);
    });
    if (this.stopped) return;

    this.interval = setInterval(() => {
      void this.options.usageService.listUsage({ forceRefresh: true }).catch((error) => {
        this.logger.debug({ err: error }, "Background provider usage refresh failed");
      });
    }, PROVIDER_USAGE_MONITOR_INTERVAL_MS);
    this.interval.unref?.();

    await this.options.usageService.listUsage({ forceRefresh: true });
    await this.evaluationQueue;
  }

  private enqueueEvaluation(result: ProviderUsageListResult): void {
    this.evaluationQueue = this.evaluationQueue
      .catch(() => undefined)
      .then(() => this.evaluate(result))
      .catch((error) => {
        this.logger.warn({ err: error }, "Failed to evaluate provider usage alerts");
      });
  }

  private async evaluate(result: ProviderUsageListResult): Promise<void> {
    const nowMs = this.options.now?.() ?? Date.now();
    const observedAt = result.fetchedAt;
    const previousSerialized = JSON.stringify({
      alerts: this.snapshotAlerts(),
      cursors: [...this.cursors.values()],
    });
    const newlyCrossed: ProviderUsageAlert[] = [];

    for (const provider of result.providers) {
      if (provider.status !== "available") continue;
      this.evaluateProvider(provider, observedAt, nowMs, newlyCrossed);
    }

    for (const [key, alert] of this.alerts) {
      const resetMs = parseTimestamp(alert.resetsAt);
      if (resetMs !== null && resetMs <= nowMs) this.alerts.delete(key);
    }

    const alerts = this.snapshotAlerts();
    const nextSerialized = JSON.stringify({ alerts, cursors: [...this.cursors.values()] });
    if (previousSerialized === nextSerialized) return;

    try {
      await this.options.store.save({ alerts, cursors: [...this.cursors.values()] });
    } catch (error) {
      this.logger.warn({ err: error }, "Failed to persist provider usage alert state");
    }
    const snapshot = { alerts, newlyCrossed: newlyCrossed.map(cloneAlert) };
    for (const listener of this.listeners) listener(snapshot);
  }

  private evaluateProvider(
    provider: ProviderUsage,
    observedAt: string,
    nowMs: number,
    newlyCrossed: ProviderUsageAlert[],
  ): void {
    const observedKeys = new Set<string>();
    for (const window of provider.windows) {
      const windowMinutes = window.windowMinutes;
      const rawUsedPct =
        window.usedPct ?? (window.remainingPct == null ? null : 100 - window.remainingPct);
      if (
        windowMinutes == null ||
        !MONITORED_WINDOW_MINUTES.has(windowMinutes) ||
        rawUsedPct == null ||
        !Number.isFinite(rawUsedPct)
      ) {
        continue;
      }

      const usedPct = Math.max(0, Math.min(100, rawUsedPct));
      const key = alertKey({ providerId: provider.providerId, windowId: window.id, windowMinutes });
      observedKeys.add(key);
      const thresholdPct = highestThreshold(usedPct);
      if (thresholdPct === null) {
        this.alerts.delete(key);
        this.cursors.delete(key);
        continue;
      }

      const resetsAt = window.resetsAt ?? null;
      const previousCursor = this.cursors.get(key);
      const previousThreshold =
        previousCursor && isSameCycle(previousCursor, resetsAt, nowMs)
          ? previousCursor.thresholdPct
          : 0;
      const alert: ProviderUsageAlert = {
        providerId: provider.providerId,
        displayName: provider.displayName,
        windowId: window.id,
        windowLabel: window.label,
        windowMinutes,
        usedPct,
        thresholdPct,
        resetsAt,
        observedAt,
      };
      this.alerts.set(key, alert);
      this.cursors.set(key, {
        providerId: provider.providerId,
        windowId: window.id,
        windowMinutes,
        thresholdPct: Math.max(previousThreshold, thresholdPct),
        resetsAt,
        lastUsedPct: usedPct,
      });
      if (thresholdPct > previousThreshold) newlyCrossed.push(alert);
    }

    for (const [key, alert] of this.alerts) {
      if (alert.providerId === provider.providerId && !observedKeys.has(key)) {
        this.alerts.delete(key);
      }
    }
  }

  private snapshotAlerts(): ProviderUsageAlert[] {
    return [...this.alerts.values()]
      .map(cloneAlert)
      .sort(
        (a, b) =>
          b.thresholdPct - a.thresholdPct ||
          b.usedPct - a.usedPct ||
          a.providerId.localeCompare(b.providerId) ||
          a.windowId.localeCompare(b.windowId),
      );
  }
}
