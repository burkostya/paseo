import { shareCheckoutDiff } from "./diff-sharing";
import { useMemo } from "react";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { useReplicaQuery } from "@/data/query";
import { checkoutDiffPushRoute } from "@/data/push-router";
import { useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import type { ParsedDiffFile, SubscribeCheckoutDiffResponse } from "@getpaseo/protocol/messages";
import { checkoutDiffQueryKey } from "@/git/query-keys";

interface UseCheckoutDiffQueryOptions {
  serverId: string;
  cwd: string;
  mode: "uncommitted" | "base";
  baseRef?: string;
  ignoreWhitespace?: boolean;
  includeWorkingTree?: boolean;
  enabled?: boolean;
  queryScope?: string;
}

type CheckoutDiffQueryPayload = Omit<SubscribeCheckoutDiffResponse["payload"], "subscriptionId">;

// Re-export the canonical protocol type so all consumers share one definition.
export type { ParsedDiffFile };
export type DiffHunk = ParsedDiffFile["hunks"][number];
export type DiffLine = DiffHunk["lines"][number];
export type HighlightToken = NonNullable<DiffLine["tokens"]>[number];

function normalizeCheckoutDiffCompare(compare: {
  mode: "uncommitted" | "base";
  baseRef?: string;
  ignoreWhitespace?: boolean;
  includeWorkingTree?: boolean;
}): {
  mode: "uncommitted" | "base";
  baseRef?: string;
  ignoreWhitespace?: boolean;
  includeWorkingTree?: boolean;
} {
  const ignoreWhitespace = compare.ignoreWhitespace === true;
  const includeWorkingTree = compare.includeWorkingTree === true;
  if (compare.mode === "uncommitted") {
    return { mode: "uncommitted", ignoreWhitespace };
  }
  const trimmedBaseRef = compare.baseRef?.trim();
  return trimmedBaseRef
    ? { mode: "base", baseRef: trimmedBaseRef, ignoreWhitespace, includeWorkingTree }
    : { mode: "base", ignoreWhitespace, includeWorkingTree };
}

export function useCheckoutDiffQuery({
  serverId,
  cwd,
  mode,
  baseRef,
  ignoreWhitespace,
  includeWorkingTree,
  enabled = true,
  queryScope,
}: UseCheckoutDiffQueryOptions) {
  const retainedPanelActive = useRetainedPanelActive();
  const queryEnabled = enabled && retainedPanelActive;
  const isConnected = useHostRuntimeIsConnected(serverId);
  const normalizedCompare = useMemo(
    () => normalizeCheckoutDiffCompare({ mode, baseRef, ignoreWhitespace, includeWorkingTree }),
    [mode, baseRef, ignoreWhitespace, includeWorkingTree],
  );
  const compareMode = normalizedCompare.mode;
  const compareBaseRef = normalizedCompare.baseRef;
  const compareIgnoreWhitespace = normalizedCompare.ignoreWhitespace;
  const queryKey = useMemo(() => {
    const comparisonKey = checkoutDiffQueryKey(
      serverId,
      cwd,
      compareMode,
      compareBaseRef,
      compareIgnoreWhitespace,
      includeWorkingTree,
    );
    const normalizedScope = queryScope?.trim();
    return normalizedScope ? [...comparisonKey, "scope", normalizedScope] : comparisonKey;
  }, [
    serverId,
    cwd,
    compareMode,
    compareBaseRef,
    compareIgnoreWhitespace,
    includeWorkingTree,
    queryScope,
  ]);
  const subscriptionId = useMemo(() => `checkoutDiff:${JSON.stringify(queryKey)}`, [queryKey]);
  const routeEnabled = Boolean(queryEnabled && isConnected && cwd);

  const query = useReplicaQuery<CheckoutDiffQueryPayload>({
    queryKey,
    structuralSharing: shareCheckoutDiff,
    enabled: routeEnabled,
    pushEvent: "checkout_diff_update",
    meta: checkoutDiffPushRoute({
      enabled: routeEnabled,
      serverId,
      subscriptionId,
      cwd,
      compare: {
        mode: compareMode,
        ...(compareBaseRef ? { baseRef: compareBaseRef } : {}),
        ignoreWhitespace: compareIgnoreWhitespace,
        includeWorkingTree,
      },
    }),
  });

  return deriveCheckoutDiffResult(query.data ?? null);
}

export interface CheckoutDiffResult {
  files: ParsedDiffFile[];
  payloadError: CheckoutDiffQueryPayload["error"];
  diffTooLarge: boolean;
  isLoading: boolean;
  isFetching: boolean;
  isError: boolean;
  error: null;
}

/**
 * The result derives from the payload alone. Until a payload arrives there is no
 * diff to describe, so the boundary reports loading rather than an empty diff —
 * whether the query is idle (an inactive retained panel), in flight, or the host
 * is disconnected. Reporting `files: []` as settled made callers render "+0 -0"
 * and "No changes" for a diff nobody has fetched yet.
 */
export function deriveCheckoutDiffResult(
  payload: CheckoutDiffQueryPayload | null,
): CheckoutDiffResult {
  const payloadError = payload?.error ?? null;
  return {
    files: payload?.files ?? [],
    payloadError,
    diffTooLarge: payload?.diffTooLarge === true,
    isLoading: payload === null,
    isFetching: false,
    isError: Boolean(payloadError),
    error: null,
  };
}
