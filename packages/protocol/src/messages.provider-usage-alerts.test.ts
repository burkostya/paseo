import { describe, expect, it } from "vitest";
import {
  ProviderUsageAlertsChangedStatusPayloadSchema,
  ProviderUsageWindowSchema,
  ServerInfoStatusPayloadSchema,
  StatusMessageSchema,
} from "./messages.js";

describe("provider usage alert protocol", () => {
  it("keeps window duration optional", () => {
    expect(
      ProviderUsageWindowSchema.parse({ id: "weekly", label: "Weekly", usedPct: 90 }),
    ).not.toHaveProperty("windowMinutes");
    expect(
      ProviderUsageWindowSchema.parse({
        id: "weekly",
        label: "Weekly",
        usedPct: 90,
        windowMinutes: 10_080,
      }).windowMinutes,
    ).toBe(10_080);
  });

  it("parses authoritative snapshots and remains a permissive status message", () => {
    const payload = {
      status: "provider.usage.alerts.changed" as const,
      alerts: [
        {
          providerId: "codex",
          displayName: "Codex",
          windowId: "session",
          windowLabel: "Session",
          windowMinutes: 300,
          usedPct: 95,
          thresholdPct: 95,
          observedAt: "2026-07-15T00:00:00.000Z",
        },
      ],
    };
    expect(ProviderUsageAlertsChangedStatusPayloadSchema.parse(payload)).toEqual(payload);
    expect(StatusMessageSchema.safeParse({ type: "status", payload }).success).toBe(true);
  });

  it("keeps the capability optional for old server_info payloads", () => {
    expect(
      ServerInfoStatusPayloadSchema.parse({ status: "server_info", serverId: "srv_old" }).features
        ?.providerUsageWarnings,
    ).toBeUndefined();
    expect(
      ServerInfoStatusPayloadSchema.parse({
        status: "server_info",
        serverId: "srv_new",
        features: { providerUsageWarnings: true },
      }).features?.providerUsageWarnings,
    ).toBe(true);
  });
});
