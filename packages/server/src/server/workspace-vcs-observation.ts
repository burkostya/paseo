import { isAbsolute, resolve } from "node:path";
import type {
  VcsBinding,
  VcsSnapshot,
  VcsProblem,
  VcsObservationPlan,
} from "@getpaseo/protocol/vcs";
import { VcsError } from "@getpaseo/plugin/server/vcs";
import {
  createFileObserver,
  type FileObserver,
  type FileObserverSubscription,
} from "./file-observer/index.js";
import type { VcsPlugins } from "./workspace-vcs-service.js";

export interface VcsObservationValue {
  result: VcsSnapshot | null;
  error: VcsProblem | null;
}
interface Consumer {
  detach?(): void;
  binding: VcsBinding;
  receive(value: VcsObservationValue): void;
}
interface Root {
  key: string;
  path: string;
  failed: boolean;
  ignore: string[];
  members: Map<Entry, { scope: "working-copy" | "repository"; kind: "files" | "metadata" }>;
  ready: Promise<FileObserverSubscription>;
}
interface Entry {
  key: string;
  binding: VcsBinding;
  consumers: Set<Consumer>;
  roots: Map<string, Root>;
  snapshot?: VcsSnapshot;
  fingerprint?: string;
  lastValue?: VcsObservationValue;
  ready: Promise<void>;
  running?: Promise<void>;
  forced?: Promise<void>;
  timer?: ReturnType<typeof setTimeout>;
  polling?: ReturnType<typeof setTimeout>;
  pollGap: number;
  degraded: boolean;
  lastRefresh: number;
  working: boolean;
  metadata: boolean;
  closed: boolean;
  closing?: Promise<void>;
  stopPlugin?: () => void;
}

const services = new WeakMap<object, WorkspaceVcsObservation>();
export function resolveWorkspaceVcsObservation(plugins: VcsPlugins): WorkspaceVcsObservation {
  let service = services.get(plugins);
  if (!service) {
    service = new WorkspaceVcsObservation(plugins);
    services.set(plugins, service);
  }
  return service;
}

/** Shared physical observations; consumers own every reference and teardown barrier. */
export class WorkspaceVcsObservation {
  private readonly entries = new Map<string, Entry>();
  private readonly roots = new Map<string, Root>();
  private readonly observer: FileObserver;
  private closing?: Promise<void>;
  constructor(
    private readonly plugins: VcsPlugins,
    observer?: FileObserver,
  ) {
    this.observer = observer ?? createFileObserver();
  }

  async subscribe(binding: VcsBinding, receive: Consumer["receive"], signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (this.closing) throw new Error("VCS observation service is closed");
    const key = JSON.stringify([binding.providerId, binding.repositoryId, binding.workingCopyId]);
    let entry = this.entries.get(key);
    if (!entry) {
      entry = {
        key,
        binding,
        consumers: new Set(),
        roots: new Map(),
        ready: Promise.resolve(),
        pollGap: 5000,
        degraded: false,
        lastRefresh: 0,
        working: false,
        metadata: false,
        closed: false,
      };
      this.entries.set(key, entry);
      const target = entry;
      target.stopPlugin = this.plugins.subscribe?.(() => this.schedule(target, true));
    }
    const target = entry;
    const consumer: Consumer = { binding, receive };
    target.consumers.add(consumer);
    if (target.consumers.size === 1 && !target.snapshot) {
      target.ready = this.refresh(target, true);
    }
    let teardown: Promise<void> | undefined;
    const unsubscribe = (): Promise<void> => {
      if (teardown) return teardown;
      signal?.removeEventListener("abort", abort);
      target.consumers.delete(consumer);
      const remaining = target.consumers.values().next().value;
      if (remaining) target.binding = remaining.binding;
      teardown = remaining ? Promise.resolve() : this.stop(target);
      return teardown;
    };
    const abort = () => {
      void unsubscribe().catch(() => {
        /* Bootstrap and owner cleanup await the same barrier. */
      });
    };
    consumer.detach = () => signal?.removeEventListener("abort", abort);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    try {
      await target.ready;
      if (teardown || target.closed)
        throw new VcsError({ code: "cancelled", message: "VCS observation was cancelled" });
      if (target.lastValue?.error) throw new VcsError(target.lastValue.error);
      if (!target.snapshot) throw new Error("VCS observation has no snapshot");
      return { snapshot: { ...target.snapshot, binding }, unsubscribe };
    } catch (error) {
      await unsubscribe();
      throw error;
    }
  }

  async snapshot(binding: VcsBinding): Promise<VcsSnapshot> {
    if (this.closing) throw new Error("VCS observation service is closed");
    const key = JSON.stringify([binding.providerId, binding.repositoryId, binding.workingCopyId]);
    const entry = this.entries.get(key);
    if (entry) {
      await entry.ready;
      entry.forced ??= (async () => {
        await entry.running;
        if (!entry.closed) await this.refresh(entry, true);
      })().finally(() => {
        entry.forced = undefined;
      });
      await entry.forced;
      if (entry.closed)
        throw new VcsError({ code: "unavailable", message: "VCS observation was closed" });
      if (entry.lastValue?.error) throw new VcsError(entry.lastValue.error);
      if (!entry.snapshot) throw new Error("VCS observation has no snapshot");
      return { ...entry.snapshot, binding };
    }
    const response = await this.plugins.invokeVcs(binding.providerId, {
      kind: "snapshot",
      binding,
    });
    if (response.kind !== "snapshot") throw new Error("Invalid VCS snapshot response");
    return response.snapshot;
  }
  getDiagnostics() {
    return {
      workingCopies: this.entries.size,
      subscriptions: [...this.entries.values()].reduce(
        (count, entry) => count + entry.consumers.size,
        0,
      ),
      roots: this.roots.size,
      polling: [...this.entries.values()].filter((entry) => !!entry.polling).length,
      ...this.observer.getDiagnostics(),
    };
  }
  close(): Promise<void> {
    this.closing ??= Promise.resolve().then(async () => {
      await Promise.all([...this.entries.values()].map((entry) => this.stop(entry)));
      return this.observer.close();
    });
    return this.closing;
  }

  private publish(entry: Entry, value: VcsObservationValue) {
    if (entry.closed || JSON.stringify(entry.lastValue) === JSON.stringify(value)) return;
    entry.lastValue = value;
    for (const consumer of entry.consumers)
      consumer.receive({
        ...value,
        result: value.result ? { ...value.result, binding: consumer.binding } : null,
      });
  }
  private schedule(entry: Entry, working: boolean) {
    if (entry.closed) return;
    entry.working ||= working;
    entry.metadata ||= !working;
    if (entry.timer) return;
    entry.timer = setTimeout(
      () => {
        entry.timer = undefined;
        if (entry.running) {
          this.schedule(entry, false);
          return;
        }
        void this.refresh(entry, false);
      },
      Math.max(200, entry.lastRefresh + 750 - Date.now()),
    );
    entry.timer.unref?.();
  }
  private poll(entry: Entry) {
    if (entry.closed || entry.polling) return;
    entry.polling = setTimeout(() => {
      entry.polling = undefined;
      this.schedule(entry, true);
    }, entry.pollGap);
    entry.polling.unref?.();
  }
  private refresh(entry: Entry, force: boolean): Promise<void> {
    if (entry.closed) return Promise.resolve();
    if (entry.running) return entry.running;
    const work = force || entry.working;
    entry.working = false;
    entry.metadata = false;
    entry.lastRefresh = Date.now();
    entry.running = this.read(entry, work)
      .catch(async (error: unknown) => {
        await this.releaseRoots(entry);
        if (entry.polling) {
          clearTimeout(entry.polling);
          entry.polling = undefined;
        }
        entry.degraded = false;
        entry.pollGap = 5000;
        this.publish(entry, {
          result: null,
          error:
            error instanceof VcsError
              ? error.problem
              : {
                  code: "provider",
                  message: error instanceof Error ? error.message : String(error),
                },
        });
        // A removed plugin resumes through its catalog event. Other transient failures are bounded.
        if (
          this.plugins
            .listVcsProviders()
            .some((provider) => provider.id === entry.binding.providerId)
        )
          this.poll(entry);
      })
      .finally(() => {
        entry.running = undefined;
        if (entry.working || entry.metadata) this.schedule(entry, false);
      });
    return entry.running;
  }
  private async read(entry: Entry, work: boolean) {
    const observation = await this.plugins.invokeVcs(entry.binding.providerId, {
      kind: "observation",
      binding: entry.binding,
    });
    if (entry.closed) return;
    if (observation.kind !== "observation") throw new Error("Invalid VCS observation response");
    const plan = observation.plan;
    const changed =
      work ||
      !entry.snapshot ||
      !!entry.lastValue?.error ||
      plan?.fingerprint !== entry.fingerprint;
    const watching = await this.syncRoots(entry, plan);
    if (entry.closed) return;
    let unchanged = !changed;
    if (changed) {
      entry.fingerprint = plan?.fingerprint;
      const response = await this.plugins.invokeVcs(entry.binding.providerId, {
        kind: "snapshot",
        binding: entry.binding,
      });
      if (entry.closed) return;
      if (response.kind !== "snapshot") throw new Error("Invalid VCS snapshot response");
      unchanged = JSON.stringify(entry.snapshot) === JSON.stringify(response.snapshot);
      entry.snapshot = response.snapshot;
      this.publish(entry, { result: response.snapshot, error: null });
    }
    if (!watching) {
      entry.pollGap = entry.degraded && unchanged ? Math.min(60000, entry.pollGap * 2) : 5000;
      entry.degraded = true;
      this.poll(entry);
    } else {
      entry.degraded = false;
      entry.pollGap = 5000;
      if (entry.polling) {
        clearTimeout(entry.polling);
        entry.polling = undefined;
      }
    }
  }
  private async syncRoots(entry: Entry, plan: VcsObservationPlan | null): Promise<boolean> {
    const wanted = new Map<
      string,
      {
        path: string;
        scope: "working-copy" | "repository";
        kind: "files" | "metadata";
        ignore: string[];
      }
    >();
    for (const root of plan?.roots ?? []) {
      if (!isAbsolute(root.path) || root.ignore?.some((path) => !isAbsolute(path)))
        throw new Error("VCS observation paths must be absolute");
      const ignore = [...new Set(root.ignore ?? [])].sort();
      const path = resolve(root.path);
      wanted.set(
        JSON.stringify([
          entry.binding.providerId,
          entry.binding.repositoryId,
          path,
          root.scope,
          root.kind ?? "metadata",
        ]),
        { path, scope: root.scope, kind: root.kind ?? "metadata", ignore },
      );
    }
    for (const [key, root] of entry.roots) {
      if (!wanted.has(key) || root.failed) {
        entry.roots.delete(key);
        await this.releaseRoot(entry, root);
      }
    }
    let watching = true;
    for (const [key, root] of wanted) {
      if (entry.closed) break;
      let shared = this.roots.get(key);
      if (shared?.failed) {
        this.roots.delete(key);
        shared = undefined;
      }
      if (!shared) {
        let target: Root | undefined;
        const ready = this.observer.subscribe(
          root.path,
          (error) => {
            if (!target) return;
            if (error) target.failed = true;
            for (const [member, source] of target.members) {
              const targets =
                source.scope === "repository"
                  ? [...this.entries.values()].filter(
                      (other) =>
                        other.binding.providerId === member.binding.providerId &&
                        other.binding.repositoryId === member.binding.repositoryId,
                    )
                  : [member];
              for (const other of targets) this.schedule(other, source.kind === "files");
            }
          },
          { ignore: root.ignore },
        );
        target = {
          key,
          path: root.path,
          failed: false,
          members: new Map(),
          ready,
          ignore: root.ignore,
        };
        this.roots.set(key, target);
        void ready.catch(() => {});
        shared = target;
      }
      shared.members.set(entry, { scope: root.scope, kind: root.kind });
      entry.roots.set(key, shared);
      try {
        const subscription = await shared.ready;
        if (JSON.stringify(shared.ignore) !== JSON.stringify(root.ignore)) {
          await subscription.updateIgnore(root.ignore);
          shared.ignore = root.ignore;
        }
      } catch {
        shared.failed = true;
        watching = false;
      }
    }
    return watching;
  }
  private async releaseRoot(entry: Entry, root: Root) {
    root.members.delete(entry);
    if (root.members.size) return;
    if (this.roots.get(root.key) === root) this.roots.delete(root.key);
    const subscription = await root.ready.catch(() => null);
    await subscription?.unsubscribe();
  }
  private async releaseRoots(entry: Entry) {
    const roots = [...entry.roots.values()];
    entry.roots.clear();
    await Promise.all(roots.map((root) => this.releaseRoot(entry, root)));
  }
  private stop(entry: Entry): Promise<void> {
    if (entry.closing) return entry.closing;
    entry.closed = true;
    if (this.entries.get(entry.key) === entry) this.entries.delete(entry.key);
    entry.stopPlugin?.();
    for (const consumer of entry.consumers) consumer.detach?.();
    entry.consumers.clear();
    if (entry.timer) clearTimeout(entry.timer);
    if (entry.polling) clearTimeout(entry.polling);
    entry.closing = Promise.resolve().then(async () => {
      await entry.running;
      await entry.forced;
      return this.releaseRoots(entry);
    });
    return entry.closing;
  }
}
