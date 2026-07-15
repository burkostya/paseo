import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderUsage } from "../../server/messages.js";
import type { ProviderUsageFetcher } from "./provider.js";
import { ProviderUsageService } from "./service.js";
import {
  ProviderUsageAlertMonitor,
  ProviderUsageAlertStore,
  type ProviderUsageAlertSnapshot,
} from "./alert-monitor.js";

const logger = pino({ level: "silent" });
const monitors: ProviderUsageAlertMonitor[] = [];

afterEach(async () => {
  await Promise.all(monitors.splice(0).map((monitor) => monitor.stop()));
  vi.useRealTimers();
});

function availableUsage(usedPct: number, options?: { resetsAt?: string }): ProviderUsage {
  return {
    providerId: "codex",
    displayName: "Codex",
    status: "available",
    planLabel: "Pro",
    windows: [
      {
        id: "session",
        label: "Session",
        windowMinutes: 300,
        usedPct,
        resetsAt: options?.resetsAt ?? "2026-07-16T00:00:00.000Z",
      },
      { id: "short", label: "Short", windowMinutes: 60, usedPct: 100 },
    ],
    balances: [{ id: "credits", label: "Credits", remaining: 0, unit: "credits" }],
  };
}

async function createMonitor(input: {
  filePath: string;
  getUsage: () => ProviderUsage;
  nowMs?: number;
}) {
  const fetcher: ProviderUsageFetcher = {
    providerId: "codex",
    displayName: "Codex",
    fetchUsage: async () => input.getUsage(),
  };
  const service = new ProviderUsageService({
    logger,
    fetchers: [fetcher],
    cacheTtlMs: 0,
    now: () => input.nowMs ?? Date.parse("2026-07-15T12:00:00.000Z"),
  });
  const monitor = new ProviderUsageAlertMonitor({
    logger,
    usageService: service,
    store: new ProviderUsageAlertStore(input.filePath),
    now: () => input.nowMs ?? Date.parse("2026-07-15T12:00:00.000Z"),
  });
  monitors.push(monitor);
  return { monitor, service };
}

describe("ProviderUsageAlertMonitor", () => {
  it("notifies once at 75, 90, and 95 percent and persists deduplication", async () => {
    const dir = await mkdtemp(join(tmpdir(), "paseo-usage-alerts-"));
    const filePath = join(dir, "alerts.json");
    let usage = availableUsage(76);
    const first = await createMonitor({ filePath, getUsage: () => usage });
    const changes: ProviderUsageAlertSnapshot[] = [];
    first.monitor.onChange((snapshot) => changes.push(snapshot));

    await first.monitor.start();
    expect(changes.at(-1)?.newlyCrossed.map((alert) => alert.thresholdPct)).toEqual([75]);
    expect(await first.monitor.getAlerts()).toHaveLength(1);

    usage = availableUsage(91);
    await first.service.refreshProvider("codex");
    await first.monitor.getAlerts();
    expect(changes.at(-1)?.newlyCrossed.map((alert) => alert.thresholdPct)).toEqual([90]);

    usage = availableUsage(96);
    await first.service.refreshProvider("codex");
    await first.monitor.getAlerts();
    expect(changes.at(-1)?.newlyCrossed.map((alert) => alert.thresholdPct)).toEqual([95]);
    await first.monitor.stop();

    const second = await createMonitor({ filePath, getUsage: () => usage });
    const restartedChanges: ProviderUsageAlertSnapshot[] = [];
    second.monitor.onChange((snapshot) => restartedChanges.push(snapshot));
    await second.monitor.start();
    expect(restartedChanges).toEqual([]);

    usage = availableUsage(10, { resetsAt: "2026-07-23T00:00:00.000Z" });
    await second.service.refreshProvider("codex");
    await second.monitor.getAlerts();
    expect(await second.monitor.getAlerts()).toEqual([]);

    usage = availableUsage(97, { resetsAt: "2026-07-23T00:00:00.000Z" });
    await second.service.refreshProvider("codex");
    await second.monitor.getAlerts();
    expect(restartedChanges.at(-1)?.newlyCrossed.map((alert) => alert.thresholdPct)).toEqual([95]);
  });

  it("ignores unavailable providers, balances, and windows other than 5h or weekly", async () => {
    const dir = await mkdtemp(join(tmpdir(), "paseo-usage-alerts-"));
    let usage: ProviderUsage = availableUsage(10);
    usage.windows = [{ id: "daily", label: "Daily", windowMinutes: 1_440, usedPct: 99 }];
    const { monitor, service } = await createMonitor({
      filePath: join(dir, "alerts.json"),
      getUsage: () => usage,
    });
    await monitor.start();
    expect(await monitor.getAlerts()).toEqual([]);

    usage = { ...availableUsage(96), status: "error", error: "offline" };
    await service.refreshProvider("codex");
    await monitor.getAlerts();
    expect(await monitor.getAlerts()).toEqual([]);
  });

  it("polls every 15 minutes and debounces post-turn refreshes per provider", async () => {
    vi.useFakeTimers();
    const dir = await mkdtemp(join(tmpdir(), "paseo-usage-alerts-"));
    let calls = 0;
    const { monitor } = await createMonitor({
      filePath: join(dir, "alerts.json"),
      getUsage: () => {
        calls += 1;
        return availableUsage(10);
      },
    });
    await monitor.start();
    expect(calls).toBe(1);

    monitor.scheduleProviderRefresh("codex");
    monitor.scheduleProviderRefresh("codex");
    await vi.advanceTimersByTimeAsync(5_000);
    await monitor.getAlerts();
    expect(calls).toBe(2);

    await vi.advanceTimersByTimeAsync(15 * 60 * 1000);
    await monitor.getAlerts();
    expect(calls).toBe(3);
  });
});
