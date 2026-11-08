import type { JsonValue } from "@getpaseo/protocol/agent-types";
import type { VcsOperation } from "../vcs.js";
import { VcsError, VcsUnknownOutcomeError } from "./vcs-error.js";

export interface VcsOperationContext {
  signal: AbortSignal;
  started(): void;
  report(result: JsonValue): void;
}
/** Reserved IDs survive completion. Cancellation never implies that a mutation was rolled back. */
export function createVcsOperationExecutor(options: {
  signal?: AbortSignal;
  serial<T>(repository: string, run: () => Promise<T>): Promise<T>;
}) {
  const entries = new Map<
    string,
    { fingerprint: string; operation: VcsOperation; controller: AbortController }
  >();
  function replay(id: string, fingerprint: string): VcsOperation | undefined {
    const entry = entries.get(id);
    if (!entry) return undefined;
    if (entry.fingerprint !== fingerprint)
      throw new Error("Operation ID was already used for another request");
    return { ...entry.operation };
  }
  function get(id: string): VcsOperation {
    return { ...(entries.get(id)?.operation ?? { id, status: "unknown" as const }) };
  }
  return {
    replay,
    has: (id: string) => entries.has(id),
    get,
    cancel(id: string): VcsOperation {
      entries.get(id)?.controller.abort();
      return get(id);
    },
    start(
      id: string,
      fingerprint: string,
      repository: string,
      run: (context: VcsOperationContext) => Promise<JsonValue | undefined>,
    ): VcsOperation {
      const existing = replay(id, fingerprint);
      if (existing) return existing;
      if (entries.size >= 10_000)
        throw new Error("VCS operation capacity reached; reload before submitting more operations");
      const controller = new AbortController();
      const operation: VcsOperation = { id, status: "pending" };
      entries.set(id, { fingerprint, operation, controller });
      const signal = options.signal
        ? AbortSignal.any([options.signal, controller.signal])
        : controller.signal;
      let mutationStarted = false;
      void options
        .serial(repository, async () => {
          signal.throwIfAborted();
          operation.status = "running";
          operation.result = await run({
            signal,
            started() {
              signal.throwIfAborted();
              mutationStarted = true;
            },
            report(result) {
              operation.result = result;
            },
          });
          operation.status = "succeeded";
        })
        .catch((error: unknown) => {
          operation.status =
            error instanceof VcsUnknownOutcomeError || (signal.aborted && mutationStarted)
              ? "unknown"
              : "failed";
          if (signal.aborted)
            operation.error = {
              code: "cancelled",
              message: "Operation cancelled; refresh to verify its outcome",
            };
          else if (error instanceof VcsError) operation.error = error.problem;
          else
            operation.error = {
              code: "provider",
              message: error instanceof Error ? error.message : String(error),
            };
        });
      return { ...operation };
    },
  };
}
