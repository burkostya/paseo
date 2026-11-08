import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { fork } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { PassThrough } from "node:stream";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pino from "pino";
import type { ProviderEvent, ProviderRegistration } from "@getpaseo/plugin/server/provider";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentStreamEvent } from "../agent/agent-sdk-types.js";
import { PluginAgentClientRegistry } from "../agent/plugin-provider.js";
import { PluginRuntime } from "./runtime.js";
import { resolveDaemonVersion } from "../daemon-version.js";
import type { PluginSessionSocket } from "./session-socket.js";

const temporaryDirectories: string[] = [];

describe("Git provider checkout", () => {
  it("pins remote branches before fetching, rejects moved sources and retains unrelated branches on rollback", async () => {
    const { execCommand } = await import("@getpaseo/plugin/server");
    const { gitProvider } = await import("../../../../../plugins/git-vcs/server/provider.js");
    const { resolveGitSource } =
      await import("../../../../../plugins/git-vcs/server/working-copies.js");
    const root = await mkdtemp(path.join(tmpdir(), "paseo-git-source-"));
    temporaryDirectories.push(root);
    const seed = path.join(root, "seed");
    const remote = path.join(root, "remote.git");
    const cwd = path.join(root, "repository");
    const git = async (args: string[], directory = seed) =>
      (
        await execCommand("git", ["-c", "commit.gpgsign=false", ...args], { cwd: directory })
      ).stdout.trim();
    await execCommand("git", ["init", "-b", "main", seed]);
    await git(["config", "user.name", "Test"]);
    await git(["config", "user.email", "test@example.test"]);
    await git(["commit", "--allow-empty", "-m", "initial"]);
    await execCommand("git", ["clone", "--bare", seed, remote]);
    await execCommand("git", ["clone", remote, cwd]);
    await git(["commit", "--allow-empty", "-m", "remote advance"]);
    const revision = await git(["rev-parse", "HEAD"]);
    await git(["push", remote, "main"]);
    const context = { signal: new AbortController().signal };
    const detection = await gitProvider.detect(cwd, context);
    if (detection.status !== "available") throw new Error("Missing Git binding");
    const binding = detection.binding;
    const selected = await resolveGitSource(
      binding,
      { kind: "branch", ref: "refs/remotes/origin/main" },
      context,
    );
    expect(selected.revision).toBe(revision);
    await expect(git(["cat-file", "-e", revision], cwd)).rejects.toThrow();
    const snapshot = await gitProvider.snapshot(binding, context);
    const input = { root: path.join(root, "copy"), name: "task", revision, data: selected.data };
    await git(["commit", "--allow-empty", "-m", "another advance"]);
    await git(["push", remote, "main"]);
    await expect(
      gitProvider.workingCopies!.create(binding, input, { ...context, snapshot }),
    ).rejects.toThrow("checkout source changed");
    expect(await git(["for-each-ref", "refs/heads/task"], cwd)).toBe("");
    await git(["push", "--force", remote, `${revision}:refs/heads/main`]);
    const record = await gitProvider.workingCopies!.create(binding, input, {
      ...context,
      snapshot,
    });
    expect(await git(["rev-parse", "HEAD"], record.binding.root)).toBe(revision);
    expect(await git(["branch", "--show-current"], record.binding.root)).toBe("task");
    await expect(
      git(["rev-parse", "--abbrev-ref", "@{upstream}"], record.binding.root),
    ).rejects.toThrow();
    await expect(
      gitProvider.workingCopies!.create(
        binding,
        { ...input, root: path.join(root, "other") },
        { ...context, snapshot },
      ),
    ).rejects.toThrow("already exists");
    await gitProvider.workingCopies!.rollback(binding, record, context);
    expect(await git(["for-each-ref", "refs/heads/task"], cwd)).toBe("");
    expect(await git(["rev-parse", "main"], cwd)).not.toBe(revision);
  });
  it.each(["subprocess", "in-process"])(
    "creates and recovers fork PR copies through the public host API in %s",
    async (mode) => {
      const { execCommand } = await import("@getpaseo/plugin/server");
      const { VcsResponseSchema, VcsWorkingCopyRecordSchema } = await import("@getpaseo/plugin");
      const { resolvedSource } =
        await import("../../../../../plugins/git-vcs/shared/working-copy.js");
      const { VcsInboundMessageSchema } = await import("@getpaseo/protocol/vcs-rpc");
      const { handleWorkspaceVcsRequest } = await import("../session/vcs/index.js");
      const {
        FileBackedProjectRegistry,
        FileBackedWorkspaceRegistry,
        createPersistedProjectRecord,
      } = await import("../workspace-registry.js");
      const { createForgeResolver } = await import("../../services/forge-resolver.js");
      const { createGitHubService } = await import("../../services/github-service.js");
      const root = await mkdtemp(path.join(tmpdir(), "paseo-git-checkout-"));
      temporaryDirectories.push(root);
      const seed = path.join(root, "seed");
      const origin = path.join(root, "origin.git");
      const forkRemote = path.join(root, "fork.git");
      const cwd = path.join(root, "repository");
      const copy = path.join(root, "copy");
      const git = async (args: string[], directory = cwd) =>
        (
          await execCommand("git", ["-c", "commit.gpgsign=false", ...args], { cwd: directory })
        ).stdout.trim();
      await execCommand("git", ["init", "-b", "main", seed]);
      await git(["config", "user.name", "Test"], seed);
      await git(["config", "user.email", "test@example.test"], seed);
      await writeFile(path.join(seed, "file.txt"), "base\n");
      await git(["add", "."], seed);
      await git(["commit", "-m", "base"], seed);
      await execCommand("git", ["clone", "--bare", seed, origin]);
      await execCommand("git", ["clone", origin, cwd]);
      await git(["switch", "-c", "feature"], seed);
      await writeFile(path.join(seed, "file.txt"), "PR\n");
      await git(["commit", "-am", "PR"], seed);
      const revision = await git(["rev-parse", "HEAD"], seed);
      await git(["push", origin, "HEAD:refs/pull/7/head"], seed);
      await execCommand("git", ["clone", "--bare", seed, forkRemote]);
      const logger = pino({ level: "silent" });
      const projects = new FileBackedProjectRegistry(path.join(root, "projects.json"), logger);
      const workspaces = new FileBackedWorkspaceRegistry(
        path.join(root, "workspaces.json"),
        logger,
      );
      await projects.initialize();
      await workspaces.initialize();
      await projects.upsert(
        createPersistedProjectRecord({
          projectId: "project",
          rootPath: cwd,
          kind: "git",
          displayName: "Git sources",
          vcsProviderId: "git",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }),
      );
      const queries: unknown[] = [];
      const forge = {
        ...createForgeResolver(),
        async resolveRepository(url: string) {
          expect(url).toBe(origin);
          return {
            forge: "github",
            host: "fixture.test",
            service: {
              ...createGitHubService(),
              async getPullRequestCheckoutTarget(input: { cwd: string; number: number }) {
                queries.push(input);
                return {
                  headRefName: "feature",
                  baseRefName: "main",
                  isCrossRepository: true,
                  headOwnerLogin: "alice",
                  headRepositoryUrl: forkRemote,
                  checkoutRefs: [{ remoteName: "origin", remoteRef: "refs/pull/7/head" }],
                };
              },
            },
          };
        },
      };
      let checkoutEnabled = false;
      let comparisonContextRequests = 0;
      let comparisonContextEnabled = false;
      const announcements = new Set<() => void>();
      const runtime = createTestRuntime(
        {
          spawnChild: () => spawnObservedPluginProcess(() => {}),
          sessionHost: {
            async attachPluginSocket(_id, socket) {
              const closed = new Promise<void>((resolve) => socket.once("close", resolve));
              const sendResponse = (message: unknown) =>
                socket.send(JSON.stringify({ type: "session", message }));
              const announce = () => {
                socket.send(
                  JSON.stringify({
                    type: "session",
                    message: {
                      type: "status",
                      payload: {
                        status: "server_info",
                        serverId: "checkout-test",
                        hostname: "checkout-test",
                        version: "0.15.2",
                        features: {
                          vcsProviders: true,
                          vcsComparisonContext: comparisonContextEnabled,
                          vcsPublication: true,
                          vcsForgeCheckout: checkoutEnabled,
                        },
                      },
                    },
                  }),
                );
              };
              announcements.add(announce);
              socket.on("message", (raw) => {
                if (typeof raw !== "string") return;
                const message = JSON.parse(raw);
                if (message.type === "hello") {
                  announce();
                  return;
                }
                if (message.type !== "session") return;
                const request = VcsInboundMessageSchema.parse(message.message);
                if (request.type === "vcs.comparison.context.request") comparisonContextRequests++;
                void handleWorkspaceVcsRequest(request, {
                  projects,
                  workspaces,
                  forge,
                  plugins: {
                    listVcsProviders: () => [{ id: "git", label: "Git", pluginId: "git-vcs" }],
                    invokeVcs: async () => {
                      throw new Error("Checkout facts must not re-enter the project executor");
                    },
                  },
                }).then(sendResponse);
              });
              return { closed };
            },
          },
        },
        logger,
        "0.15.2",
      );
      const invoke = async (request: import("@getpaseo/plugin").VcsRequest) =>
        VcsResponseSchema.parse(await runtime.invoke("git-vcs", "vcs.git.request", request));
      const completed = async (
        request: import("@getpaseo/plugin").VcsRequest & { operationId: string },
      ) => {
        await Promise.all([invoke(request), invoke(request)]);
        await expect
          .poll(async () => {
            const result = await invoke({ kind: "operation", operationId: request.operationId });
            if (result.kind !== "operation") throw new Error(JSON.stringify(result));
            if (result.operation.status === "failed")
              throw new Error(JSON.stringify(result.operation.error));
            return result.operation.status;
          })
          .toBe("succeeded");
        const result = await invoke({ kind: "operation", operationId: request.operationId });
        if (result.kind !== "operation") throw new Error("Missing operation");
        return result.operation.result;
      };
      try {
        const directory = path.resolve("../../plugins/git-vcs");
        if (mode === "subprocess") await runtime.startPlugin("git-vcs", directory);
        else await runtime.startBuiltinPlugin({ id: "git-vcs", directory });
        const detection = await invoke({ kind: "detect", cwd });
        if (detection.kind !== "detect" || detection.detection.status !== "available")
          throw new Error(JSON.stringify(detection));
        const binding = detection.detection.binding;
        expect(await invoke({ kind: "snapshot", binding })).toMatchObject({
          snapshot: {
            data: {
              data: { comparisonBase: { warning: expect.stringContaining("Update the host") } },
            },
          },
        });
        expect(comparisonContextRequests).toBe(0);
        comparisonContextEnabled = true;
        for (const announce of announcements) announce();
        await expect
          .poll(() => invoke({ kind: "snapshot", binding }))
          .toMatchObject({
            kind: "snapshot",
            snapshot: {
              data: {
                data: {
                  comparisonBase: {
                    baseRef: "refs/remotes/origin/main",
                    error: null,
                    warning: null,
                  },
                },
              },
            },
          });
        expect(comparisonContextRequests).toBeGreaterThan(0);
        await expect(
          runtime.invoke("git-vcs", "source.resolve", {
            binding,
            selection: { kind: "change-request", forge: "github", number: 7 },
          }),
        ).rejects.toThrow("Update the host to resolve forge checkout sources");
        expect(queries).toHaveLength(0);
        checkoutEnabled = true;
        for (const announce of announcements) announce();
        const sourceResponse = await handleWorkspaceVcsRequest(
          {
            type: "vcs.project.working-copy.resolve-source.request",
            requestId: "source",
            projectId: "project",
            providerId: "git",
            input: { version: 1, data: { kind: "change-request", forge: "github", number: 7 } },
          },
          {
            projects,
            workspaces,
            forge,
            plugins: {
              listVcsProviders: () => [{ id: "git", label: "Git", pluginId: "git-vcs" }],
              invokeVcs: async (_id, request) => invoke(request),
            },
          },
        );
        expect(sourceResponse.payload.error).toBeNull();
        const prepared = resolvedSource.parse(sourceResponse.payload.result);
        expect(prepared.revision).toBe(revision);
        expect(await git(["for-each-ref", "--format=%(refname)"])).not.toContain("refs/paseo/");
        await expect(git(["cat-file", "-e", revision])).rejects.toThrow();
        const snapshot = await invoke({ kind: "snapshot", binding });
        if (snapshot.kind !== "snapshot") throw new Error("Missing snapshot");
        let record = VcsWorkingCopyRecordSchema.parse(
          await completed({
            kind: "execute",
            binding,
            action: "working-copy.create",
            operationId: "create-pr",
            version: snapshot.snapshot.version,
            input: { root: copy, name: "task", revision, data: prepared.data },
          }),
        );
        expect(queries).toHaveLength(2);
        expect(await git(["rev-parse", "HEAD"], copy)).toBe(revision);
        const branch = await git(["branch", "--show-current"], copy);
        expect(branch).toBe("alice/feature");
        expect(await git(["rev-parse", "--abbrev-ref", "@{upstream}"], copy)).toBe(
          "paseo-copy-task/feature",
        );
        expect(await git(["config", `branch.${branch}.pushRemote`], copy)).toBe("paseo-copy-task");
        expect(await git(["for-each-ref", "--format=%(refname)"])).not.toContain(
          "refs/paseo/creation/",
        );
        const publication = await invoke({
          kind: "publication.resolve",
          binding: record.binding,
          selection: { remote: "paseo-copy-task", headRef: branch, baseRef: "main" },
        });
        if (publication.kind !== "publication") throw new Error(JSON.stringify(publication));
        expect(publication.publication).toMatchObject({
          headRef: "feature",
          headRevision: revision,
          data: { data: { localBranch: branch } },
        });
        await completed({
          kind: "publication.publish",
          binding: record.binding,
          target: publication.publication,
          operationId: "push",
        });
        expect(
          await git(["--git-dir", forkRemote, "for-each-ref", "--format=%(refname)"]),
        ).not.toContain("alice/feature");
        const gitDirectory = await git(["rev-parse", "--absolute-git-dir"], copy);
        const metadata = JSON.parse(
          await readFile(path.join(gitDirectory, "paseo/worktree.json"), "utf8"),
        );
        expect(metadata).toMatchObject({
          baseRef: "main",
          changeRequestLookupTarget: {
            headRef: "feature",
            localBranchName: branch,
            changeRequestNumber: 7,
            headRepositoryOwner: "alice",
          },
        });
        record = VcsWorkingCopyRecordSchema.parse(
          await completed({
            kind: "working-copy.recovery",
            operation: "prepare-removal",
            record,
            operationId: "prepare",
          }),
        );
        record = VcsWorkingCopyRecordSchema.parse(
          await completed({
            kind: "working-copy.recovery",
            operation: "remove",
            record,
            operationId: "remove",
          }),
        );
        const main = await git(["rev-parse", "main"]);
        await git(["update-ref", `refs/heads/${branch}`, main, revision]);
        await invoke({
          kind: "working-copy.recovery",
          operation: "restore",
          record,
          operationId: "moved",
        });
        await expect
          .poll(() => invoke({ kind: "operation", operationId: "moved" }))
          .toMatchObject({ operation: { status: "failed", error: { code: "outdated" } } });
        await expect(readFile(path.join(copy, "file.txt"))).rejects.toMatchObject({
          code: "ENOENT",
        });
        await git(["branch", "-D", branch]);
        record = VcsWorkingCopyRecordSchema.parse(
          await completed({
            kind: "working-copy.recovery",
            operation: "restore",
            record,
            operationId: "restore",
          }),
        );
        expect(await git(["branch", "--show-current"], copy)).toBe(branch);
        expect(await git(["rev-parse", "--abbrev-ref", "@{upstream}"], copy)).toBe(
          "paseo-copy-task/feature",
        );
        expect(
          JSON.parse(
            await readFile(
              path.join(
                await git(["rev-parse", "--absolute-git-dir"], copy),
                "paseo/worktree.json",
              ),
              "utf8",
            ),
          ),
        ).toEqual(metadata);
        record = VcsWorkingCopyRecordSchema.parse(
          await completed({
            kind: "working-copy.recovery",
            operation: "release",
            record,
            operationId: "release",
          }),
        );
        expect(record.recovery).toBeUndefined();
        await invoke({ kind: "working-copy.rollback", binding, record });
        expect(await git(["remote"])).toBe("origin");
        expect(await git(["for-each-ref", "--format=%(refname)"])).not.toContain("alice/feature");
      } finally {
        await runtime.stopAll();
      }
    },
  );
});

function hasCompletedAgentTurn(events: readonly AgentStreamEvent[]): boolean {
  return events.some((event) => event.type === "turn_completed");
}

async function createPlugin(id: string, source: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-plugin-"));
  temporaryDirectories.push(directory);
  await writeFile(path.join(directory, "paseo-plugin.json"), JSON.stringify({ id }), "utf8");
  await writeFile(path.join(directory, "index.server.ts"), source, "utf8");
  return directory;
}

async function readTextIfPresent(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

function pluginMessages(runtime: PluginRuntime, pluginId: string): string[] {
  return runtime.getLogs(pluginId).map((entry) => entry.message);
}

function spawnObservedPluginProcess(onMessage: (message: unknown) => void) {
  const loaderUrl = new URL("../../terminal/terminal-ts-loader.mjs", import.meta.url).href;
  const setup = `import { register } from "node:module"; register(${JSON.stringify(loaderUrl)});`;
  const child = fork(new URL("./plugin-process.ts", import.meta.url), [], {
    execArgv: [
      "--experimental-strip-types",
      "--import",
      `data:text/javascript,${encodeURIComponent(setup)}`,
    ],
    serialization: "advanced",
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  child.on("message", onMessage);
  return child;
}

function createReloadChild(
  name: string,
  events: string[],
  methods: string[] = [],
  providers: Array<{ id: string; label: string }> = [],
) {
  const listeners = new Map<string, Array<(message: never) => void>>();
  const emit = (event: string, message: unknown) => {
    for (const listener of listeners.get(event) ?? []) listener(message as never);
  };
  return {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    connected: true,
    killed: false,
    send(message: { type: string }, callback?: (error: Error | null) => void) {
      callback?.(null);
      if (message.type === "initialize") {
        events.push(`start:${name}`);
        queueMicrotask(() => emit("message", { type: "ready", methods, providers }));
      }
      if (message.type === "shutdown") {
        events.push(`shutdown:${name}`);
        this.connected = false;
        queueMicrotask(() => {
          events.push(`exit:${name}`);
          emit("close", null);
        });
      }
      return true;
    },
    kill() {
      this.killed = true;
      this.connected = false;
      queueMicrotask(() => emit("close", null));
      return true;
    },
    disconnect() {
      this.connected = false;
    },
    on(event: string, listener: (message: never) => void) {
      const registered = listeners.get(event) ?? [];
      registered.push(listener);
      listeners.set(event, registered);
      return this;
    },
    emitMessage(message: unknown) {
      emit("message", message);
    },
  };
}

function sha256(text: string | undefined): string {
  return createHash("sha256")
    .update(text ?? "")
    .digest("hex");
}

function createTestRuntime(
  dependencies: NonNullable<ConstructorParameters<typeof PluginRuntime>[2]> = {},
  logger = pino({ level: "silent" }),
  version = "0.4.0",
): PluginRuntime {
  return new PluginRuntime(logger, version, {
    ...dependencies,
    sessionHost: dependencies.sessionHost ?? {
      async attachPluginSocket(_pluginId, socket) {
        const closed = new Promise<void>((resolve) => socket.once("close", resolve));
        socket.on("message", (data) => {
          if (typeof data !== "string") return;
          const message = JSON.parse(data);
          if (message.type !== "hello") return;
          socket.send(
            JSON.stringify({
              type: "session",
              message: {
                type: "status",
                payload: {
                  status: "server_info",
                  serverId: "plugin-test",
                  hostname: "plugin-test",
                  version,
                  features: {},
                },
              },
            }),
          );
        });
        return { closed };
      },
    },
  });
}

function createTrackedSessionHost() {
  const active = new Set<object>();
  // One entry per hello handshake: an attached socket is not a redialled one.
  const hellos: object[] = [];
  const waiters = new Set<{ count: number; resolve: () => void }>();
  function recordHello(socket: object): void {
    hellos.push(socket);
    for (const waiter of waiters) {
      if (hellos.length < waiter.count) continue;
      waiters.delete(waiter);
      waiter.resolve();
    }
  }
  return {
    active,
    hellos,
    // Resolves on the handshake itself rather than after a delay, so the test
    // waits for the event it cares about instead of a guess at how long it takes.
    waitForHellos(count: number): Promise<void> {
      if (hellos.length >= count) return Promise.resolve();
      return new Promise<void>((resolve) => {
        waiters.add({ count, resolve });
      });
    },
    host: {
      async attachPluginSocket(_pluginId: string, socket: PluginSessionSocket) {
        const closed = new Promise<void>((resolve) => socket.once("close", resolve));
        active.add(socket);
        socket.once("close", () => active.delete(socket));
        socket.on("message", (data) => {
          if (typeof data !== "string") return;
          const message = JSON.parse(data);
          if (message.type !== "hello") return;
          recordHello(socket);
          socket.send(
            JSON.stringify({
              type: "session",
              message: {
                type: "status",
                payload: {
                  status: "server_info",
                  serverId: "tracked-plugin-test",
                  hostname: "tracked-plugin-test",
                  version: "0.4.0",
                  features: {},
                },
              },
            }),
          );
        });
        return { closed };
      },
    },
  };
}

function lifecycleMessages(runtime: PluginRuntime): string[] {
  return runtime
    .getLogs("lifecycle-output")
    .map((entry) => entry.message)
    .filter((message) => message === "initialized" || message === "initialization warning")
    .sort();
}

function hasCompletedTurn(events: readonly ProviderEvent[]): boolean {
  return events.some((event) => event.type === "session.turn" && event.state === "completed");
}

function hasReadyRequest(events: readonly ProviderEvent[], requestId: string): boolean {
  return events.some((event) => event.type === "session.ready" && event.requestId === requestId);
}

function runtimeFailure(events: readonly ProviderEvent[]): ProviderEvent | undefined {
  return events.find((event) => event.type === "session.runtime_failed");
}

function providerCloseCount(
  messages: readonly { type: string; connectionId?: string }[],
  connectionId: string | undefined,
): number {
  return messages.filter(
    (message) => message.type === "provider.close" && message.connectionId === connectionId,
  ).length;
}

function hasMessageType(messages: readonly { type: string }[], type: string): boolean {
  return messages.some((message) => message.type === type);
}

function adaptRuntimeProvider(
  runtime: PluginRuntime,
  pluginId: string,
  metadata: { id: string; label: string; description?: string; icon?: string },
): ProviderRegistration {
  return {
    ...metadata,
    connect: (request) => runtime.connectProvider(pluginId, metadata.id, request),
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("PluginRuntime", () => {
  it.each([
    { specifier: "@getpaseo/plugin", moduleDirectory: "shared" },
    { specifier: "@getpaseo/plugin", moduleDirectory: "server" },
  ])(
    "loads $specifier contracts without React in the subprocess module graph",
    async ({ specifier, moduleDirectory }) => {
      const directory = await createPlugin(
        "react-free",
        `import { rpc } from "./${moduleDirectory}/contract";
export default function contribute(server) {
  server.handle(rpc, (input) => input);
  return () => {};
}`,
      );
      await mkdir(path.join(directory, moduleDirectory));
      await writeFile(
        path.join(directory, moduleDirectory, "contract.ts"),
        `import { defineRpc, defineAttachmentSource } from "${specifier}";
import { z } from "zod";
export const rpc = defineRpc({ name: "echo", input: z.string(), output: z.string() });
const source = defineAttachmentSource({ id: "test", search: rpc });
if (source.search !== rpc) throw new Error("Attachment contract was not preserved");`,
      );
      // Reject imports even when the workspace has React installed. This covers the host's
      // static graph and SDK imports evaluated through the compiled plugin's runtimeRequire.
      const guard = `export function resolve(specifier, context, nextResolve) {
  if (/^(react|react-dom|react-native|use-sync-external-store)(\\/|$)/.test(specifier)) {
    throw new Error("React module reached plugin subprocess: " + specifier);
  }
  return nextResolve(specifier, context);
}`;
      const guardUrl = `data:text/javascript,${encodeURIComponent(guard)}`;
      const loaderUrl = new URL("../../terminal/terminal-ts-loader.mjs", import.meta.url).href;
      const setup = `import { register } from "node:module";
register(${JSON.stringify(loaderUrl)});
register(${JSON.stringify(guardUrl)});`;
      const runtime = createTestRuntime({
        spawnChild: () =>
          fork(new URL("./plugin-process.ts", import.meta.url), [], {
            execArgv: [
              "--experimental-strip-types",
              "--import",
              `data:text/javascript,${encodeURIComponent(setup)}`,
            ],
            serialization: "advanced",
            stdio: ["ignore", "pipe", "pipe", "ipc"],
          }),
      });
      try {
        await runtime.startPlugin("react-free", directory);
        await expect(runtime.invoke("react-free", "echo", "hello")).resolves.toBe("hello");
      } catch (error) {
        throw new Error(JSON.stringify(runtime.getLogs("react-free")), { cause: error });
      } finally {
        await runtime.stopAll();
      }
    },
  );

  it("runs the direct example through the existing AgentClient path", async () => {
    const pluginId = "provider-direct-example";
    const directory = fileURLToPath(
      new URL("../../../../../plugin-examples/provider-direct/", import.meta.url),
    );
    const runtime = createTestRuntime({}, undefined, "0.8.0");
    await runtime.startPlugin(pluginId, directory);
    const [metadata] = runtime.getProviderRegistrations(pluginId);
    expect(metadata).toBeDefined();
    const adapters = new PluginAgentClientRegistry(pino({ level: "silent" }));
    adapters.replace([adaptRuntimeProvider(runtime, pluginId, metadata!)]);
    const client = adapters.clients()[metadata!.id];

    const session = await client!.createSession({ provider: metadata!.id, cwd: directory });
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));
    await expect(session.startTurn("hello", { clientMessageId: "direct-client" })).resolves.toEqual(
      { turnId: "turn-1" },
    );
    await expect.poll(() => hasCompletedAgentTurn(events)).toBe(true);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "timeline",
        item: {
          type: "assistant_message",
          id: undefined,
          messageId: "assistant-1",
          text: "Echo: hello",
        },
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "provider_subagent",
        event: expect.objectContaining({ type: "timeline" }),
      }),
    );

    await session.close();
    await adapters.shutdown();
    await runtime.stopAll();
  });

  it("runs a provider connection through the real plugin subprocess boundary", async () => {
    const directory = await createPlugin(
      "provider-round-trip",
      `import type { PluginServerContext } from "@getpaseo/plugin/server";
import type { ProviderEvent, ProviderRegistration } from "@getpaseo/plugin/server/provider";

const provider: ProviderRegistration = {
  id: "direct-example",
  label: "Direct example",
  icon: "icon.svg",
  async connect(request) {
    const listeners = new Set<(event: ProviderEvent) => void>();
    const emit = (event: ProviderEvent) => {
      for (const listener of listeners) listener(event);
    };
    return {
      version: request.versions[0] ?? 1,
      capabilities: request.capabilities,
      async send(input) {
        if (input.type === "session.open") {
          emit({
            type: "session.opened",
            requestId: input.requestId,
            sessionId: input.sessionId,
            capabilities: request.capabilities,
            restoration: "core",
            persistence: { version: 1, data: { resume: "native-1" } },
            cwd: input.config.cwd,
            futureField: "ignored by this protocol version",
          } as ProviderEvent);
          emit({
            type: "session.config",
            sessionId: input.sessionId,
            config: {
              model: "example-1",
              models: [{ id: "example-1", label: "Example 1" }],
              modes: [],
              thinkingOptions: [],
              settings: [
                { type: "toggle", id: "concise", label: "Concise", value: true },
              ],
            },
          });
          emit({ type: "session.ready", requestId: input.requestId, sessionId: input.sessionId });
          return;
        }
        if (input.type !== "session.prompt") return;
        if (input.prompt.input.type === "command") {
          emit({
            type: "session.prompt_result",
            sessionId: input.sessionId,
            clientMessageId: input.prompt.clientMessageId,
            result: { type: "completed" },
          });
          return;
        }
        emit({
          type: "timeline.item",
          sessionId: input.sessionId,
          item: {
            type: "user_message",
            id: "user-1",
            text: "hello",
            clientMessageId: input.prompt.clientMessageId,
          },
        });
        emit({
          type: "session.prompt_result",
          sessionId: input.sessionId,
          clientMessageId: input.prompt.clientMessageId,
          result: { type: "turn", turnId: "turn-1" },
        });
        emit({
          type: "session.opened",
          sessionId: "child-1",
          parentSessionId: input.sessionId,
          capabilities: [],
          restoration: "parent",
          cwd: "/repo",
        });
        emit({
          type: "timeline.item",
          sessionId: "child-1",
          item: {
            type: "plugin",
            id: "review-1",
            pluginId: "provider-round-trip",
            kind: "review",
            version: 1,
            data: { verdict: "ship" },
          },
        });
      },
      onEvent(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      async close() {},
    };
  },
};

export default function contribute(server: PluginServerContext) {
  server.registerProvider(provider);
  return () => {};
}`,
    );
    const runtime = createTestRuntime();
    await runtime.startPlugin("provider-round-trip", directory);

    const [registration] = runtime.getProviderRegistrations("provider-round-trip");
    expect(registration).toMatchObject({
      id: "direct-example",
      label: "Direct example",
      iconPath: "icon.svg",
    });
    const connection = await runtime.connectProvider("provider-round-trip", "direct-example", {
      versions: [1],
      capabilities: [
        "prompt.message",
        "prompt.command",
        "session.configure",
        "session.persistence",
        "session.subsession",
        "timeline.plugin",
        "future.capability",
      ],
    });
    expect(connection.capabilities).not.toContain("future.capability");
    const events: ProviderEvent[] = [];
    const unsubscribe = connection.onEvent((event) => events.push(event));

    await connection.send({
      type: "session.open",
      requestId: "open-1",
      sessionId: "root-1",
      config: {
        cwd: "/repo",
        env: {},
        mcpServers: {},
        settings: {},
        persist: true,
      },
      history: "replay",
    });
    await connection.send({
      type: "session.prompt",
      sessionId: "root-1",
      prompt: {
        clientMessageId: "client-1",
        delivery: "auto",
        input: { type: "message", content: [{ type: "text", text: "hello" }] },
      },
    });
    await connection.send({
      type: "session.prompt",
      sessionId: "root-1",
      prompt: {
        clientMessageId: "client-2",
        delivery: "auto",
        input: { type: "command", name: "compact", arguments: "" },
      },
    });

    await expect.poll(() => events.length).toBe(8);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "session.prompt_result",
        clientMessageId: "client-1",
        result: { type: "turn", turnId: "turn-1" },
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "session.prompt_result",
        clientMessageId: "client-2",
        result: { type: "completed" },
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "session.opened",
        sessionId: "child-1",
        parentSessionId: "root-1",
      }),
    );
    expect(events.find((event) => event.type === "session.opened")).not.toHaveProperty(
      "futureField",
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "timeline.item",
        sessionId: "child-1",
        item: expect.objectContaining({ type: "plugin", pluginId: "provider-round-trip" }),
      }),
    );

    unsubscribe();
    await connection.close();
    await runtime.stopAll();
  });

  it("adapts an ACP command and example transformer through the AgentClient path", async () => {
    const transformerPath = fileURLToPath(
      new URL(
        "../../../../../plugin-examples/provider-acp-transformer/server/vendor-edit.ts",
        import.meta.url,
      ),
    );
    const directory = await createPlugin(
      "provider-acp-round-trip",
      `import type { PluginServerContext } from "@getpaseo/plugin/server";
import { runAcpProvider } from "@getpaseo/plugin/server/acp";
import { vendorEditTransformer } from "./server/vendor-edit.js";

export default function contribute(server: PluginServerContext) {
  server.registerProvider(runAcpProvider({
    id: "acp-example",
    label: "ACP example",
    command: [process.execPath, __ACP_COMMAND__],
    transformers: [vendorEditTransformer],
  }));
  return () => {};
}`,
    );
    await mkdir(path.join(directory, "server"));
    await writeFile(
      path.join(directory, "server/vendor-edit.ts"),
      await readFile(transformerPath, "utf8"),
      "utf8",
    );
    const agentPath = path.join(directory, "fake-acp.cjs");
    await writeFile(
      agentPath,
      `const readline = require("node:readline");
const lines = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: message.params.protocolVersion, agentCapabilities: {} } });
  } else if (message.method === "session/new") {
    send({ jsonrpc: "2.0", id: message.id, result: { sessionId: "native-1", modes: null, configOptions: [] } });
  } else if (message.method === "session/prompt") {
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "native-1", update: { sessionUpdate: "tool_call", toolCallId: "edit-1", name: "vendor_file_edit", title: "Vendor edit", status: "completed", rawInput: { path: "/tmp/example.ts", before: "old", after: "new" } } } });
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "native-1", update: { sessionUpdate: "agent_message_chunk", messageId: "assistant-1", content: { type: "text", text: "ACP says hi" } } } });
    send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
  } else if (message.method === "session/close" || message.method === "session/cancel") {
    send({ jsonrpc: "2.0", id: message.id, result: {} });
  }
});`,
      "utf8",
    );
    const pluginPath = path.join(directory, "index.server.ts");
    const pluginSource = (await readFile(pluginPath, "utf8")).replace(
      "__ACP_COMMAND__",
      JSON.stringify(agentPath),
    );
    await writeFile(pluginPath, pluginSource, "utf8");

    const runtime = createTestRuntime();
    await runtime.startPlugin("provider-acp-round-trip", directory);
    const connection = await runtime.connectProvider("provider-acp-round-trip", "acp-example", {
      versions: [1],
      capabilities: ["prompt.message", "session.persistence"],
    });
    const events: ProviderEvent[] = [];
    connection.onEvent((event) => events.push(event));

    await connection.send({
      type: "session.open",
      requestId: "open-acp",
      sessionId: "paseo-1",
      config: { cwd: directory, env: {}, mcpServers: {}, settings: {}, persist: true },
      history: "skip",
    });
    await expect.poll(() => hasReadyRequest(events, "open-acp")).toBe(true);
    await connection.send({
      type: "session.prompt",
      sessionId: "paseo-1",
      prompt: {
        clientMessageId: "client-acp",
        delivery: "auto",
        input: { type: "message", content: [{ type: "text", text: "hello" }] },
      },
    });

    await expect.poll(() => hasCompletedTurn(events)).toBe(true);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "session.prompt_result",
        clientMessageId: "client-acp",
        result: { type: "turn", turnId: "acp:client-acp" },
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "timeline.item",
        item: expect.objectContaining({
          type: "assistant_message",
          id: JSON.stringify(["agent_message_chunk", "assistant-1"]),
          messageId: "assistant-1",
          text: "ACP says hi",
        }),
      }),
    );

    await connection.close();
    const [metadata] = runtime.getProviderRegistrations("provider-acp-round-trip");
    const adapters = new PluginAgentClientRegistry(pino({ level: "silent" }));
    adapters.replace([adaptRuntimeProvider(runtime, "provider-acp-round-trip", metadata!)]);
    const client = adapters.clients()[metadata!.id];
    const session = await client!.createSession({ provider: metadata!.id, cwd: directory });
    const agentEvents: AgentStreamEvent[] = [];
    session.subscribe((event) => agentEvents.push(event));
    await expect(
      session.startTurn("hello", { clientMessageId: "agent-client-acp" }),
    ).resolves.toEqual({ turnId: "acp:agent-client-acp" });
    await expect.poll(() => hasCompletedAgentTurn(agentEvents)).toBe(true);
    expect(agentEvents).toContainEqual(
      expect.objectContaining({
        type: "timeline",
        item: expect.objectContaining({ type: "assistant_message", text: "ACP says hi" }),
      }),
    );
    expect(agentEvents).toContainEqual(
      expect.objectContaining({
        type: "timeline",
        item: expect.objectContaining({
          type: "tool_call",
          callId: "edit-1",
          detail: {
            type: "edit",
            filePath: "/tmp/example.ts",
            oldString: "old",
            newString: "new",
            unifiedDiff: undefined,
          },
        }),
      }),
    );
    await session.close();
    await adapters.shutdown();
    await runtime.stopAll();
  });

  it("rejects a malformed provider event from a real plugin subprocess", async () => {
    const directory = await createPlugin(
      "malicious-provider",
      `import type { ProviderEvent, ProviderRegistration } from "@getpaseo/plugin/server/provider";
let connectionId = "";
process.on("message", (message: unknown) => {
  const value = message as { type?: string; connectionId?: string };
  if (value.type === "provider.connect") connectionId = value.connectionId ?? "";
});
const provider: ProviderRegistration = {
  id: "malicious",
  label: "Malicious",
  async connect(request) {
    const listeners = new Set<(event: ProviderEvent) => void>();
    const emit = (event: ProviderEvent) => { for (const listener of listeners) listener(event); };
    return {
      version: request.versions[0] ?? 1,
      capabilities: ["prompt.message"],
      async send(input) {
        if (input.type === "session.open") {
          emit({ type: "session.opened", requestId: input.requestId, sessionId: input.sessionId, capabilities: ["prompt.message"], restoration: "core", cwd: input.config.cwd });
          emit({ type: "session.ready", requestId: input.requestId, sessionId: input.sessionId });
        } else if (input.type === "session.prompt") {
          process.send?.({ type: "provider.event", connectionId, event: { type: "invented.event", sessionId: input.sessionId } });
        }
      },
      onEvent(listener) { listeners.add(listener); return () => listeners.delete(listener); },
      async close() {},
    };
  },
};
export default function contribute(server: any) { server.registerProvider(provider); return () => undefined; }`,
    );
    const runtime = createTestRuntime();
    await runtime.startPlugin("malicious-provider", directory);
    const connection = await runtime.connectProvider("malicious-provider", "malicious", {
      versions: [1],
      capabilities: ["prompt.message"],
    });
    const events: ProviderEvent[] = [];
    connection.onEvent((event) => events.push(event));
    await connection.send({
      type: "session.open",
      requestId: "open-malicious",
      sessionId: "root-malicious",
      config: { cwd: "/repo", env: {}, mcpServers: {}, settings: {}, persist: true },
      history: "skip",
    });

    await expect(
      connection.send({
        type: "session.prompt",
        sessionId: "root-malicious",
        prompt: {
          clientMessageId: "malformed-now",
          delivery: "auto",
          input: { type: "message", content: [{ type: "text", text: "break transport" }] },
        },
      }),
    ).rejects.toThrow("invalid message");
    expect(events).toContainEqual(
      expect.objectContaining({ type: "session.runtime_failed", sessionId: "root-malicious" }),
    );
    expect(runtime.catalog()).toHaveLength(1);
    await runtime.stopAll();
  });

  it("emits runtime failure for live sessions when a real plugin process dies", async () => {
    const directory = await createPlugin(
      "dying-provider",
      `import type { ProviderEvent, ProviderRegistration } from "@getpaseo/plugin/server/provider";
const provider: ProviderRegistration = {
  id: "dying",
  label: "Dying",
  async connect(request) {
    const listeners = new Set<(event: ProviderEvent) => void>();
    const emit = (event: ProviderEvent) => { for (const listener of listeners) listener(event); };
    return {
      version: request.versions[0] ?? 1,
      capabilities: ["prompt.message"],
      async send(input) {
        if (input.type === "session.open") {
          emit({ type: "session.opened", requestId: input.requestId, sessionId: input.sessionId, capabilities: ["prompt.message"], restoration: "core", cwd: input.config.cwd });
          emit({ type: "session.ready", requestId: input.requestId, sessionId: input.sessionId });
        }
        if (input.type === "session.prompt") setTimeout(() => process.exit(17), 10);
      },
      onEvent(listener) { listeners.add(listener); return () => listeners.delete(listener); },
      async close() {},
    };
  },
};
export default function contribute(server: any) { server.registerProvider(provider); return () => undefined; }`,
    );
    const runtime = createTestRuntime();
    await runtime.startPlugin("dying-provider", directory);
    const connection = await runtime.connectProvider("dying-provider", "dying", {
      versions: [1],
      capabilities: ["prompt.message"],
    });
    const events: ProviderEvent[] = [];
    connection.onEvent((event) => events.push(event));
    await connection.send({
      type: "session.open",
      requestId: "open-dying",
      sessionId: "root-dying",
      config: { cwd: "/repo", env: {}, mcpServers: {}, settings: {}, persist: true },
      history: "skip",
    });
    await connection.send({
      type: "session.prompt",
      sessionId: "root-dying",
      prompt: {
        clientMessageId: "die-now",
        delivery: "auto",
        input: { type: "message", content: [{ type: "text", text: "bye" }] },
      },
    });

    await expect
      .poll(() => runtimeFailure(events))
      .toMatchObject({
        type: "session.runtime_failed",
        sessionId: "root-dying",
        error: { message: "Plugin process exited: dying-provider" },
      });
    await runtime.stopAll();
  });

  it("records host-owned plugin lifecycle events", async () => {
    const directory = await createPlugin(
      "lifecycle",
      `export default function contribute(plugin: unknown) { void plugin; return () => undefined; }`,
    );
    const child = createReloadChild("lifecycle", []);
    const runtime = createTestRuntime({ spawnChild: () => child });

    await runtime.startPlugin("lifecycle", directory);
    await runtime.stopPluginById("lifecycle");

    expect(
      runtime.getLogs("lifecycle").map(({ stream, message }) => ({ stream, message })),
    ).toEqual([
      { stream: "stdout", message: "[paseo] Loading plugin" },
      { stream: "stdout", message: "[paseo] Plugin ready" },
      { stream: "stdout", message: "[paseo] Stopping plugin" },
      { stream: "stdout", message: "[paseo] Plugin stopped" },
    ]);
  });

  it("frames stdout and stderr, normalizes CRLF, and flushes final fragments once", async () => {
    const directory = await createPlugin(
      "output",
      `export default function contribute(plugin: unknown) { void plugin; return () => undefined; }`,
    );
    const child = createReloadChild("output", []);
    const runtime = createTestRuntime({ spawnChild: () => child });
    await runtime.startPlugin("output", directory);

    child.stdout.write("first\r");
    child.stdout.write("\n");
    child.stderr.write("problem\nfinal stderr");
    child.stdout.write("final stdout");
    await runtime.stopPluginById("output");

    const logs = runtime.getLogs("output");
    expect(
      logs
        .filter((entry) => !entry.message.startsWith("[paseo]"))
        .map(({ stream, message }) => ({ stream, message })),
    ).toEqual([
      { stream: "stdout", message: "first" },
      { stream: "stderr", message: "problem" },
      { stream: "stderr", message: "final stderr" },
      { stream: "stdout", message: "final stdout" },
    ]);
    expect(logs.map((entry) => entry.sequence)).toEqual(
      Array.from({ length: logs.length }, (_, index) => index + 1),
    );
  });

  it("writes plugin output through the daemon logger with structured identity fields", async () => {
    const directory = await createPlugin(
      "tagged-output",
      `export default function contribute(plugin: unknown) { void plugin; return () => undefined; }`,
    );
    const child = createReloadChild("tagged-output", []);
    const records: Array<Record<string, unknown>> = [];
    const logger = pino(
      { level: "info" },
      { write: (line: string) => records.push(JSON.parse(line) as Record<string, unknown>) },
    );
    const runtime = createTestRuntime({ spawnChild: () => child }, logger);
    await runtime.startPlugin("tagged-output", directory);

    child.stderr.write("connection failed\n");

    expect(records.find((record) => record.message === "connection failed")).toMatchObject({
      module: "plugins",
      pluginId: "tagged-output",
      sequence: 3,
      stream: "stderr",
      message: "connection failed",
    });
    expect(records.find((record) => record.message === "connection failed")?.timestamp).toEqual(
      expect.any(String),
    );
    await runtime.stopAll();
  });

  it("bounds retained output by entry count, total bytes, and individual line bytes", async () => {
    const directory = await createPlugin(
      "noisy",
      `export default function contribute(plugin: unknown) { void plugin; return () => undefined; }`,
    );
    const child = createReloadChild("noisy", []);
    const runtime = createTestRuntime({ spawnChild: () => child });
    await runtime.startPlugin("noisy", directory);

    child.stdout.write(
      `${Array.from({ length: 510 }, (_, index) => `line-${index}`).join("\n")}\n`,
    );
    expect(runtime.getLogs("noisy")).toHaveLength(500);
    expect(runtime.getLogs("noisy")[0]?.message).toBe("line-10");

    child.stdout.write(`${Array.from({ length: 20 }, () => "x".repeat(16 * 1024)).join("\n")}\n`);
    expect(runtime.getLogs("noisy")).toHaveLength(16);

    child.stderr.write("y".repeat(20 * 1024));
    await runtime.stopPluginById("noisy");
    const logs = runtime.getLogs("noisy");
    expect(logs.length).toBeLessThanOrEqual(500);
    expect(
      logs.reduce((bytes, entry) => bytes + Buffer.byteLength(entry.message), 0),
    ).toBeLessThanOrEqual(256 * 1024);
    expect(logs.every((entry) => Buffer.byteLength(entry.message) <= 16 * 1024)).toBe(true);
    expect(logs).toContainEqual(
      expect.objectContaining({ stream: "stderr", message: "y".repeat(16 * 1024) }),
    );
  });

  it("captures output emitted during initialization and cleanup across reloads", async () => {
    const directory = await createPlugin(
      "lifecycle-output",
      `export default function contribute(plugin: unknown) {
  void plugin;
  console.log("initialized");
  console.error("initialization warning");
  return () => process.stdout.write("cleanup fragment");
}`,
    );
    const runtime = createTestRuntime();

    await runtime.startPlugin("lifecycle-output", directory);
    await expect
      .poll(() => lifecycleMessages(runtime))
      .toEqual(["initialization warning", "initialized"]);
    await runtime.stopPluginById("lifecycle-output");
    await runtime.startPlugin("lifecycle-output", directory);
    await runtime.stopPluginById("lifecycle-output");

    const logs = runtime.getLogs("lifecycle-output");
    expect(
      logs
        .filter((entry) => entry.stream === "stdout")
        .map((entry) => entry.message)
        .filter((message) => message === "initialized" || message === "cleanup fragment"),
    ).toEqual(["initialized", "cleanup fragment", "initialized", "cleanup fragment"]);
    expect(
      logs
        .filter((entry) => entry.stream === "stderr")
        .map((entry) => entry.message)
        .filter((message) => message === "initialization warning"),
    ).toEqual(["initialization warning", "initialization warning"]);
    expect(logs.map((entry) => entry.sequence)).toEqual(
      Array.from({ length: logs.length }, (_, index) => index + 1),
    );
  });

  it("retains compilation failures in the plugin stderr tail", async () => {
    const directory = await createPlugin("broken-compile", `export default function contribute( {`);
    const runtime = createTestRuntime();

    await expect(runtime.startPlugin("broken-compile", directory)).rejects.toThrow();

    expect(
      runtime.getLogs("broken-compile").map(({ stream, message }) => ({ stream, message })),
    ).toEqual([
      {
        stream: "stdout",
        message: "[paseo] Loading plugin",
      },
      {
        stream: "stderr",
        message: expect.stringContaining("Plugin failed to load:"),
      },
    ]);
    await runtime.stopAll();
  });

  it("waits for the old subprocess to exit before starting its replacement", async () => {
    const directory = await createPlugin(
      "reloadable",
      `export default function contribute(plugin: unknown) { void plugin; return () => undefined; }`,
    );
    const events: string[] = [];
    const children = [createReloadChild("old", events), createReloadChild("new", events)];
    const runtime = createTestRuntime({
      spawnChild: () => {
        const child = children.shift();
        if (!child) throw new Error("Unexpected extra child");
        return child;
      },
    });
    await runtime.startPlugin("configured-id", directory);

    await runtime.stopPluginById("configured-id");
    await runtime.startPlugin("configured-id", directory);

    expect(events).toEqual(["start:old", "shutdown:old", "exit:old", "start:new"]);
    await runtime.stopAll();
  });

  it("rejects pending RPCs when the plugin stops", async () => {
    const directory = await createPlugin(
      "pending",
      `export default function contribute(plugin: unknown) { void plugin; return () => undefined; }`,
    );
    const child = createReloadChild("pending", [], ["wait"]);
    const runtime = createTestRuntime({
      spawnChild: () => child,
    });
    await runtime.startPlugin("pending", directory);

    const rejection = expect(runtime.invoke("pending", "wait", {})).rejects.toThrow(
      "Plugin stopped: pending",
    );
    await runtime.stopPluginById("pending");

    await rejection;
  });

  it("waits for asynchronous plugin cleanup before stopping", async () => {
    const cleanupFile = path.join(tmpdir(), `paseo-plugin-cleanup-${Date.now()}`);
    const directory = await createPlugin(
      "async-cleanup",
      `import { writeFile } from "node:fs/promises";
export default function contribute(plugin: unknown) {
  void plugin;
  return async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    await writeFile(${JSON.stringify(cleanupFile)}, "cleaned");
  };
}`,
    );
    const runtime = createTestRuntime();
    await runtime.startPlugin("async-cleanup", directory);

    await runtime.stopPluginById("async-cleanup");

    await expect(readFile(cleanupFile, "utf8")).resolves.toBe("cleaned");
    await rm(cleanupFile, { force: true });
  });

  it("rejects provider input while a connection is closing", async () => {
    const releaseDirectory = await mkdtemp(path.join(tmpdir(), "paseo-provider-close-"));
    const releaseFile = path.join(releaseDirectory, "release");
    const directory = await createPlugin(
      "closing-provider",
      `import { readFile, writeFile } from "node:fs/promises";
import type { ProviderRegistration } from "@getpaseo/plugin/server/provider";
const provider: ProviderRegistration = {
  id: "delayed",
  label: "Delayed",
  async connect() {
    return {
      version: 1,
      capabilities: [],
      async send() { console.log("provider accepted input"); },
      onEvent() { return () => undefined; },
      async close() {
        console.log("provider close started");
        while (true) {
          try { await readFile(${JSON.stringify(releaseFile)}); break; }
          catch { await new Promise((resolve) => setTimeout(resolve, 10)); }
        }
        console.log("provider close completed");
      },
    };
  },
};
export default function contribute(server: { registerProvider(provider: ProviderRegistration): void }) {
  server.registerProvider(provider);
  return () => console.log("plugin cleanup started");
}`,
    );
    const closedReports: unknown[] = [];
    const observeMessage = (message: unknown) => {
      if ((message as { type?: string }).type === "provider.closed") closedReports.push(message);
    };
    const runtime = createTestRuntime({
      spawnChild: () => spawnObservedPluginProcess(observeMessage),
    });
    await runtime.startPlugin("closing-provider", directory);
    try {
      const connection = await runtime.connectProvider("closing-provider", "delayed", {
        versions: [1],
        capabilities: [],
      });
      const closing = connection.close();
      await expect
        .poll(() => pluginMessages(runtime, "closing-provider"))
        .toContain("provider close started");
      await expect(connection.send({ type: "catalog", requestId: "during-close" })).rejects.toThrow(
        "Provider connection is closing",
      );
      const stopping = runtime.stopPluginById("closing-provider");
      await expect
        .poll(() => pluginMessages(runtime, "closing-provider"))
        .toContain("plugin cleanup started");
      await writeFile(releaseFile, "release");
      await Promise.all([closing, stopping]);
      const messages = pluginMessages(runtime, "closing-provider");
      expect(messages).toContain("provider close completed");
      expect(messages).not.toContain("provider accepted input");
      expect(closedReports).toHaveLength(1);
    } finally {
      await writeFile(releaseFile, "release");
      await runtime.stopAll();
      await rm(releaseDirectory, { recursive: true, force: true });
    }
  });

  it("closes a provider connection that resolves during plugin shutdown", async () => {
    const suffix = `${process.pid}-${Date.now()}`;
    const startedFile = path.join(tmpdir(), `paseo-provider-connect-started-${suffix}`);
    const closedFile = path.join(tmpdir(), `paseo-provider-connect-closed-${suffix}`);
    const directory = await createPlugin(
      "shutdown-connect",
      `import { writeFile } from "node:fs/promises";
import type { ProviderRegistration } from "@getpaseo/plugin/server/provider";

const provider: ProviderRegistration = {
  id: "delayed",
  label: "Delayed",
  async connect() {
    await writeFile(${JSON.stringify(startedFile)}, "started");
    await new Promise((resolve) => setTimeout(resolve, 100));
    return {
      version: 1,
      capabilities: [],
      async send() {},
      onEvent() { return () => undefined; },
      async close() { await writeFile(${JSON.stringify(closedFile)}, "closed"); },
    };
  },
};

export default function contribute(server: { registerProvider(provider: ProviderRegistration): void }) {
  server.registerProvider(provider);
  return () => undefined;
}`,
    );
    const runtime = createTestRuntime();
    await runtime.startPlugin("shutdown-connect", directory);
    const pending = runtime.connectProvider("shutdown-connect", "delayed", {
      versions: [1],
      capabilities: [],
    });
    await expect.poll(() => readTextIfPresent(startedFile)).toBe("started");

    const stopping = runtime.stopPluginById("shutdown-connect");
    await expect(pending).rejects.toThrow("Plugin stopped: shutdown-connect");
    await stopping;

    await expect(readFile(closedFile, "utf8")).resolves.toBe("closed");
    await Promise.all([rm(startedFile, { force: true }), rm(closedFile, { force: true })]);
  });

  it("closes a provider connection that arrives after negotiation timed out", async () => {
    const directory = await createPlugin(
      "late-provider",
      `export default function contribute(plugin: unknown) { void plugin; return () => undefined; }`,
    );
    const child = createReloadChild(
      "late-provider",
      [],
      [],
      [{ id: "provider", label: "Provider" }],
    );
    const sent: Array<{ type: string; connectionId?: string }> = [];
    const originalSend = child.send.bind(child);
    child.send = (message, callback) => {
      sent.push(message);
      if (message.type === "provider.connect") {
        callback?.(null);
        return true;
      }
      return originalSend(message, callback);
    };
    const runtime = createTestRuntime({ spawnChild: () => child });
    await runtime.startPlugin("late-provider", directory);
    vi.useFakeTimers();
    try {
      const rejected = expect(
        runtime.connectProvider("late-provider", "provider", {
          versions: [1],
          capabilities: [],
        }),
      ).rejects.toThrow("timed out");
      await vi.advanceTimersByTimeAsync(30_000);
      await rejected;
      const connectionId = sent.find(
        (message) => message.type === "provider.connect",
      )?.connectionId;
      expect(
        sent.filter(
          (message) => message.type === "provider.close" && message.connectionId === connectionId,
        ),
      ).toHaveLength(1);

      child.emitMessage({
        type: "provider.connected",
        connectionId,
        version: 1,
        capabilities: [],
      });
      await vi.advanceTimersByTimeAsync(0);

      expect(
        sent.filter(
          (message) => message.type === "provider.close" && message.connectionId === connectionId,
        ),
      ).toHaveLength(2);
      child.emitMessage({ type: "provider.closed", connectionId });
    } finally {
      await runtime.stopAll();
      vi.useRealTimers();
    }
  });

  it("closes child-side state after invalid provider negotiation", async () => {
    const directory = await createPlugin(
      "invalid-provider",
      `export default function contribute(plugin: unknown) { void plugin; return () => undefined; }`,
    );
    const child = createReloadChild(
      "invalid-provider",
      [],
      [],
      [{ id: "provider", label: "Provider" }],
    );
    const sent: Array<{ type: string; connectionId?: string }> = [];
    const originalSend = child.send.bind(child);
    child.send = (message, callback) => {
      sent.push(message);
      if (message.type === "provider.connect") {
        callback?.(null);
        queueMicrotask(() =>
          child.emitMessage({
            type: "provider.connected",
            connectionId: message.connectionId,
            version: 2,
            capabilities: [],
          }),
        );
        return true;
      }
      return originalSend(message, callback);
    };
    const runtime = createTestRuntime({ spawnChild: () => child });
    await runtime.startPlugin("invalid-provider", directory);

    await expect(
      runtime.connectProvider("invalid-provider", "provider", {
        versions: [1],
        capabilities: [],
      }),
    ).rejects.toThrow("unoffered version");
    const connectionId = sent.find((message) => message.type === "provider.connect")?.connectionId;
    await expect.poll(() => sent).toContainEqual({ type: "provider.close", connectionId });
    child.emitMessage({ type: "provider.closed", connectionId });
    await runtime.stopAll();
  });

  it("closes a late connection after the child rejected its negotiation", async () => {
    const directory = await createPlugin(
      "rejected-provider",
      `export default function contribute(plugin: unknown) { void plugin; return () => undefined; }`,
    );
    const child = createReloadChild(
      "rejected-provider",
      [],
      [],
      [{ id: "provider", label: "Provider" }],
    );
    const sent: Array<{ type: string; connectionId?: string }> = [];
    const originalSend = child.send.bind(child);
    child.send = (message, callback) => {
      sent.push(message);
      if (message.type === "provider.connect") {
        callback?.(null);
        queueMicrotask(() =>
          child.emitMessage({
            type: "provider.connect_failed",
            connectionId: message.connectionId,
            error: "provider rejected connection",
          }),
        );
        return true;
      }
      return originalSend(message, callback);
    };
    const runtime = createTestRuntime({ spawnChild: () => child });
    await runtime.startPlugin("rejected-provider", directory);

    await expect(
      runtime.connectProvider("rejected-provider", "provider", {
        versions: [1],
        capabilities: [],
      }),
    ).rejects.toThrow("provider rejected connection");
    const connectionId = sent.find((message) => message.type === "provider.connect")?.connectionId;
    const closesBeforeLateSuccess = providerCloseCount(sent, connectionId);

    child.emitMessage({
      type: "provider.connected",
      connectionId,
      version: 1,
      capabilities: [],
    });

    await expect
      .poll(() => providerCloseCount(sent, connectionId))
      .toBe(closesBeforeLateSuccess + 1);
    child.emitMessage({ type: "provider.closed", connectionId });
    await runtime.stopAll();
  });

  it("closes a late connection after plugin shutdown cancels negotiation", async () => {
    const directory = await createPlugin(
      "canceled-provider",
      `export default function contribute(plugin: unknown) { void plugin; return () => undefined; }`,
    );
    const child = createReloadChild(
      "canceled-provider",
      [],
      [],
      [{ id: "provider", label: "Provider" }],
    );
    const sent: Array<{ type: string; connectionId?: string }> = [];
    const originalSend = child.send.bind(child);
    child.send = (message, callback) => {
      sent.push(message);
      if (message.type === "provider.connect" || message.type === "shutdown") {
        callback?.(null);
        return true;
      }
      return originalSend(message, callback);
    };
    const runtime = createTestRuntime({ spawnChild: () => child });
    await runtime.startPlugin("canceled-provider", directory);
    const pending = runtime.connectProvider("canceled-provider", "provider", {
      versions: [1],
      capabilities: [],
    });
    await expect.poll(() => hasMessageType(sent, "provider.connect")).toBe(true);
    const connectionId = sent.find((message) => message.type === "provider.connect")?.connectionId;
    const rejection = pending.then(
      () => null,
      (error: unknown) => error,
    );
    const stopping = runtime.stopPluginById("canceled-provider");
    try {
      await expect.poll(() => providerCloseCount(sent, connectionId)).toBe(1);
      await expect(rejection).resolves.toMatchObject({
        message: "Plugin stopped: canceled-provider",
      });
      const closesBeforeLateSuccess = providerCloseCount(sent, connectionId);
      child.emitMessage({
        type: "provider.connected",
        connectionId,
        version: 1,
        capabilities: [],
      });
      await expect
        .poll(() => providerCloseCount(sent, connectionId))
        .toBe(closesBeforeLateSuccess + 1);
    } finally {
      child.kill();
      await stopping;
    }
  });

  it("escalates a plugin that ignores graceful shutdown from TERM to KILL", async () => {
    vi.useFakeTimers();
    try {
      const directory = await createPlugin(
        "held-cleanup",
        `export default function contribute(plugin: unknown) { void plugin; return () => undefined; }`,
      );
      const child = createReloadChild("held-cleanup", []);
      const originalSend = child.send.bind(child);
      child.send = (message, callback) => {
        if (message.type !== "shutdown") return originalSend(message, callback);
        callback?.(null);
        return true;
      };
      const signals: Array<NodeJS.Signals | undefined> = [];
      const originalKill = child.kill.bind(child);
      child.kill = (signal?: NodeJS.Signals) => {
        signals.push(signal);
        if (signal === "SIGKILL") return originalKill();
        child.killed = true;
        return true;
      };
      const runtime = createTestRuntime({ spawnChild: () => child });
      await runtime.startPlugin("held-cleanup", directory);

      const stopping = runtime.stopPluginById("held-cleanup");
      await vi.advanceTimersByTimeAsync(2_000);
      expect(signals).toEqual(["SIGTERM"]);
      await vi.advanceTimersByTimeAsync(2_000);
      await stopping;
      expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("kills a plugin child that fails initialization", async () => {
    const directory = await createPlugin(
      "broken",
      `export default function contribute(plugin: unknown) { void plugin; return () => undefined; }`,
    );
    const listeners = new Map<string, Array<(message: never) => void>>();
    const child = {
      connected: true,
      killed: false,
      send(message: { type: string }, callback?: (error: Error | null) => void) {
        callback?.(null);
        if (message.type === "initialize") {
          queueMicrotask(() => {
            for (const listener of listeners.get("message") ?? []) {
              listener({ type: "fatal", error: "broken plugin" } as never);
            }
          });
        }
        return true;
      },
      kill() {
        this.killed = true;
        this.connected = false;
        return true;
      },
      disconnect() {
        this.connected = false;
      },
      on(event: string, listener: (message: never) => void) {
        const registered = listeners.get(event) ?? [];
        registered.push(listener);
        listeners.set(event, registered);
        return this;
      },
    };
    const runtime = createTestRuntime({
      spawnChild: () => child,
    });

    await expect(runtime.startPlugin("broken", directory)).rejects.toThrow("broken plugin");

    expect(child.killed).toBe(true);
    await runtime.stopAll();
  });

  it("rejects a server contribution without cleanup", async () => {
    const directory = await createPlugin(
      "missing-cleanup",
      `export default function contribute(plugin: unknown) { void plugin; }`,
    );
    const runtime = createTestRuntime();

    await expect(runtime.startPlugin("missing-cleanup", directory)).rejects.toThrow(
      "must return a cleanup function",
    );
    expect(runtime.catalog()).toEqual([]);
    await runtime.stopAll();
  });

  it("loads the official Linear attachment extension", async () => {
    const directory = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../../../../plugin-examples/linear",
    );
    const runtime = createTestRuntime({}, undefined, "0.8.0");

    await runtime.startPlugin("linear", directory);

    expect(runtime.catalog().map((plugin) => plugin.id)).toEqual(["linear"]);
    expect(runtime.catalog()[0]?.clientBundle).toContain("Attach Linear issue");
    expect(runtime.catalog()[0]?.clientBundle).not.toContain("LINEAR_API_KEY");
    expect(runtime.catalog()[0]?.clientBundle).not.toContain("api.linear.app");
    await runtime.stopAll();
  });

  it("explains that an index.ts plugin was made for an older Paseo version", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "paseo-plugin-"));
    temporaryDirectories.push(directory);
    await Promise.all([
      writeFile(path.join(directory, "paseo-plugin.json"), JSON.stringify({ id: "legacy" })),
      writeFile(path.join(directory, "index.ts"), "export default function contribute() {}"),
    ]);
    const runtime = createTestRuntime();

    await expect(runtime.startPlugin("legacy", directory)).rejects.toThrow(
      "This plugin was made for an older version of Paseo and cannot run on Paseo v0.8. Ask its author to update it. Plugin authors can follow the migration guide: https://paseo.sh/docs/plugins/migration",
    );
  });

  it("loads a client-only plugin without spawning a subprocess", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "paseo-plugin-"));
    temporaryDirectories.push(directory);
    await Promise.all([
      writeFile(path.join(directory, "paseo-plugin.json"), JSON.stringify({ id: "theme" })),
      writeFile(
        path.join(directory, "index.client.tsx"),
        `export default function contribute(client: any) {
  client.addTheme({ id: "theme", name: "Theme", appearance: "dark", colors: {} });
  return () => undefined;
}`,
      ),
    ]);
    const spawnChild = vi.fn();
    const runtime = createTestRuntime({ spawnChild });

    await runtime.startPlugin("theme", directory);

    expect(spawnChild).not.toHaveBeenCalled();
    expect(runtime.catalog()[0]?.clientBundle).toContain("addTheme");
    expect(runtime.catalog()[0]?.clientBundleHash).toBe(sha256(runtime.catalog()[0]?.clientBundle));
    await runtime.stopAll();
  });

  it("loads separate entries, exposes the client bundle, and invokes the server RPC", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "paseo-plugin-"));
    temporaryDirectories.push(directory);
    await mkdir(path.join(directory, "shared"));
    await writeFile(path.join(directory, "paseo-plugin.json"), JSON.stringify({ id: "hello" }));
    await writeFile(
      path.join(directory, "index.client.tsx"),
      `import React from "react";
import { Text } from "react-native";
import { defineAttachmentSource } from "@getpaseo/plugin";
import { greetRpc } from "./shared/greet";

const attachments = defineAttachmentSource({
  id: "issues",
  title: "Example issue",
  icon: "CircleDot",
  pickerTitle: "Attach example issue",
  searchPlaceholder: "Search issues",
  search: greetRpc,
});

function HelloSurface() {
  return <Text>Hello from native UI</Text>;
}

function ReviewPanel() {
  return <Text>Workspace review panel</Text>;
}

export default function contribute(client: any) {
  client.addSurface("main", HelloSurface);
  client.addSidebarItem({ id: "hello", title: "Hello", icon: "Sparkles", surface: "main" });
  client.addWorkspacePanel({ id: "review", title: "Review", icon: "Scan", context: "workspace", Component: ReviewPanel });
  client.addCommandCenterItem({ id: "open-review", title: "Open review", icon: "Scan", context: "workspace", onSelect() {} });
  client.addAttachmentSource(attachments);
  return () => undefined;
}`,
    );
    await writeFile(
      path.join(directory, "shared", "greet.ts"),
      `import { z } from "zod";
import { defineRpc } from "@getpaseo/plugin";
export const greetRpc = defineRpc({
  name: "greet",
  input: z.object({ name: z.string() }),
  output: z.object({ message: z.string(), platform: z.string() }),
});`,
    );
    await writeFile(
      path.join(directory, "index.server.ts"),
      `import { platform } from "node:os";
import { greetRpc } from "./shared/greet";
export default function contribute(server: any) {
  server.handle(greetRpc, async (input: { name: string }) => ({
    message: "Hello, " + input.name,
    platform: platform(),
  }));
  return () => undefined;
}`,
    );
    const runtime = createTestRuntime();

    await runtime.startPlugin("hello", directory);

    const catalog = runtime.catalog();
    expect(catalog).toHaveLength(1);
    expect(catalog[0]?.id).toBe("hello");
    expect(catalog[0]?.clientBundle).toContain("Hello from native UI");
    expect(catalog[0]?.clientBundle).toContain("Attach example issue");
    expect(catalog[0]?.clientBundle).toContain("Workspace review panel");
    expect(catalog[0]?.clientBundle).toContain("Open review");
    expect(catalog[0]?.clientBundle).not.toContain("node:os");
    expect(catalog[0]?.clientBundle).not.toContain("get: () => from[key]");
    await expect(runtime.invoke("hello", "greet", { name: "Paseo" })).resolves.toMatchObject({
      message: "Hello, Paseo",
    });
    await expect(runtime.invoke("hello", "greet", { name: 7 })).rejects.toThrow();

    await runtime.stopAll();
  });

  it("keeps client and server modules in their target runtime", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "paseo-plugin-"));
    temporaryDirectories.push(directory);
    await Promise.all([
      mkdir(path.join(directory, "client")),
      mkdir(path.join(directory, "server")),
      mkdir(path.join(directory, "shared")),
    ]);
    await Promise.all([
      writeFile(
        path.join(directory, "paseo-plugin.json"),
        JSON.stringify({ id: "split-runtime" }),
        "utf8",
      ),
      writeFile(
        path.join(directory, "index.client.tsx"),
        `import type { PluginClientContext } from "@getpaseo/plugin/client";
import { Surface } from "./client/surface";
export default function contribute(client: PluginClientContext) {
  client.addSurface("main", Surface);
  return () => undefined;
}`,
        "utf8",
      ),
      writeFile(
        path.join(directory, "index.server.ts"),
        `import type { PluginServerContext } from "@getpaseo/plugin/server";
import { inspectRpc } from "./shared/inspect";
import { inspectHost } from "./server/inspect";
export default function contribute(server: PluginServerContext) {
  server.handle(inspectRpc, inspectHost);
  return () => undefined;
}`,
        "utf8",
      ),
      writeFile(
        path.join(directory, "client", "surface.tsx"),
        `import React from "react";
import { StyleSheet, Text } from "react-native";

const styles = StyleSheet.create({ label: { fontWeight: "600" } });

export function Surface() {
  return <Text style={styles.label}>Client-only surface</Text>;
}`,
        "utf8",
      ),
      writeFile(
        path.join(directory, "shared", "inspect.ts"),
        `import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const inspectRpc = defineRpc({
  name: "inspect",
  input: z.object({}),
  output: z.object({ platform: z.string() }),
});`,
        "utf8",
      ),
      writeFile(
        path.join(directory, "server", "inspect.ts"),
        `import { platform } from "node:os";
import type { z } from "zod";
import { inspectRpc } from "../shared/inspect";

export function inspectHost(_input: z.input<typeof inspectRpc.input>) {
  return { platform: platform() };
}`,
        "utf8",
      ),
    ]);
    const runtime = createTestRuntime();

    await runtime.startPlugin("split-runtime", directory);

    const plugin = runtime.catalog()[0];
    expect(plugin?.clientBundle).toContain("Client-only surface");
    expect(plugin?.clientBundle).not.toContain("node:os");
    expect(plugin?.clientBundleHash).toBe(sha256(plugin?.clientBundle));
    await expect(runtime.invoke("split-runtime", "inspect", {})).resolves.toMatchObject({
      platform: expect.any(String),
    });
    await runtime.stopAll();
  });

  it("rejects server imports from client-only modules", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "paseo-plugin-"));
    temporaryDirectories.push(directory);
    await Promise.all([
      mkdir(path.join(directory, "client")),
      mkdir(path.join(directory, "server")),
    ]);
    await Promise.all([
      writeFile(
        path.join(directory, "paseo-plugin.json"),
        JSON.stringify({ id: "cross-runtime-import" }),
        "utf8",
      ),
      writeFile(
        path.join(directory, "index.client.tsx"),
        `import type { PluginClientContext } from "@getpaseo/plugin/client";
import { Surface } from "./client/surface";

export default function contribute(client: PluginClientContext) {
  client.addSurface("main", Surface);
  return () => undefined;
}`,
        "utf8",
      ),
      writeFile(
        path.join(directory, "client", "surface.tsx"),
        `import { readSecret } from "../server/secret";
export function Surface() { return readSecret(); }`,
        "utf8",
      ),
      writeFile(
        path.join(directory, "server", "secret.ts"),
        `export function readSecret() { return null; }`,
        "utf8",
      ),
    ]);
    const runtime = createTestRuntime();

    await expect(runtime.startPlugin("cross-runtime-import", directory)).rejects.toThrow(
      "server-only module cannot be imported into the plugin client bundle",
    );
    await runtime.stopAll();
  });

  it("rejects client imports from server-only modules", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "paseo-plugin-"));
    temporaryDirectories.push(directory);
    await Promise.all([
      mkdir(path.join(directory, "client")),
      mkdir(path.join(directory, "server")),
      mkdir(path.join(directory, "shared")),
    ]);
    await Promise.all([
      writeFile(
        path.join(directory, "paseo-plugin.json"),
        JSON.stringify({ id: "cross-runtime-import" }),
        "utf8",
      ),
      writeFile(
        path.join(directory, "index.server.ts"),
        `import type { PluginServerContext } from "@getpaseo/plugin/server";
import { inspect } from "./server/inspect";
import { inspectRpc } from "./shared/inspect";

export default function contribute(server: PluginServerContext) {
  server.handle(inspectRpc, inspect);
  return () => undefined;
}`,
        "utf8",
      ),
      writeFile(
        path.join(directory, "shared", "inspect.ts"),
        `import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
export const inspectRpc = defineRpc({
  name: "inspect",
  input: z.object({}),
  output: z.object({}),
});`,
        "utf8",
      ),
      writeFile(
        path.join(directory, "server", "inspect.ts"),
        `import { Surface } from "../client/surface";
export function inspect() { void Surface; return {}; }`,
        "utf8",
      ),
      writeFile(
        path.join(directory, "client", "surface.tsx"),
        `export function Surface() { return null; }`,
        "utf8",
      ),
    ]);
    const runtime = createTestRuntime();

    await expect(runtime.startPlugin("cross-runtime-import", directory)).rejects.toThrow(
      "client-only module cannot be imported into the plugin server bundle",
    );
    await runtime.stopAll();
  });

  it("rejects a handler result that does not match its RPC output schema", async () => {
    const directory = await createPlugin(
      "invalid-output",
      `import { z } from "zod";
import { defineRpc } from "@getpaseo/plugin";
const brokenRpc = defineRpc({
  name: "broken",
  input: z.object({}),
  output: z.object({ value: z.number() }),
});
export default function contribute(plugin: any) {
  plugin.handle(brokenRpc, async () => ({ value: "wrong" }));
  return () => undefined;
}`,
    );
    const runtime = createTestRuntime();

    await runtime.startPlugin("invalid-output", directory);

    await expect(runtime.invoke("invalid-output", "broken", {})).rejects.toThrow();
    await runtime.stopAll();
  });

  it("uses the config key as runtime identity without comparing the manifest id", async () => {
    const directory = await createPlugin(
      "actual",
      `export default function contribute(plugin: unknown) { void plugin; return () => undefined; }`,
    );
    const runtime = createTestRuntime();

    await runtime.startPlugin("configured", directory);

    expect(runtime.catalog().map((plugin) => plugin.id)).toEqual(["configured"]);
    await runtime.stopAll();
  });

  it("does not publish a plugin when lifecycle intent changes while it starts", async () => {
    const directory = await createPlugin(
      "blocked",
      `export default function contribute(plugin: unknown) { void plugin; return () => undefined; }`,
    );
    const events: string[] = [];
    const child = createReloadChild("blocked", events);
    const runtime = createTestRuntime({ spawnChild: () => child });

    await expect(
      runtime.startPlugin("blocked", directory, () => events.length === 0),
    ).rejects.toThrow("Plugin start cancelled: blocked");

    expect(runtime.catalog()).toEqual([]);
    expect(events).toEqual(["start:blocked", "shutdown:blocked", "exit:blocked"]);
  });

  it("reports an unexpected subprocess crash and removes its catalog entry", async () => {
    const directory = await createPlugin(
      "crashing",
      `export default function contribute(plugin: unknown) {
  void plugin;
  process.stdout.write("before crash");
  setTimeout(() => process.exit(17), 20);
  return () => undefined;
}`,
    );
    const sessions = createTrackedSessionHost();
    const runtime = createTestRuntime({ sessionHost: sessions.host });
    const crashed = new Promise<string>((resolve) => {
      runtime.subscribe((pluginId, error) => {
        if (pluginId === "crashing" && error) resolve(error);
      });
    });
    await runtime.startPlugin("crashing", directory);

    await expect(crashed).resolves.toBe("Plugin process exited: crashing");
    expect(sessions.active.size).toBe(0);
    expect(runtime.catalog()).toEqual([]);
    expect(runtime.getLogs("crashing").map((entry) => entry.message)).toContain("before crash");
    await expect(runtime.invoke("crashing", "anything", {})).rejects.toThrow(
      "Plugin is not available",
    );
  });

  it("re-attaches a plugin session when the daemon closes the socket under a live child", async () => {
    const directory = await createPlugin(
      "reattaching",
      `export default function contribute(plugin: unknown) { void plugin; return () => undefined; }`,
    );
    const sessions = createTrackedSessionHost();
    const runtime = createTestRuntime({ sessionHost: sessions.host });
    await runtime.startPlugin("reattaching", directory);

    expect(sessions.active.size).toBe(1);
    expect(sessions.hellos).toHaveLength(1);
    const first = [...sessions.active][0] as PluginSessionSocket;

    // What an expired lease does: drop the socket, leave the process running.
    first.close(1000, "expired application lease");

    // A second handshake, not just a second attachment: the client really redialled.
    await sessions.waitForHellos(2);

    expect(sessions.active.size).toBe(1);
    expect([...sessions.active][0]).not.toBe(first);
    await runtime.stopAll();
    expect(sessions.active.size).toBe(0);
  });

  it("replaces a closed plugin session only once the child sends a fresh hello", async () => {
    const directory = await createPlugin(
      "lazy-reattach",
      `export default function contribute(plugin: unknown) { void plugin; return () => undefined; }`,
    );
    const sessions = createTrackedSessionHost();
    const child = createReloadChild("lazy-reattach", []);
    const runtime = createTestRuntime({ spawnChild: () => child, sessionHost: sessions.host });
    await runtime.startPlugin("lazy-reattach", directory);
    const first = [...sessions.active][0] as PluginSessionSocket;
    // This child is a stub with no real client, so no handshake has happened.
    expect(sessions.hellos).toHaveLength(0);

    first.close(1000, "expired application lease");
    expect(sessions.active.size).toBe(0);

    // Frames the child had already queued belong to the session that just died.
    // Standing a socket up for one would leave it unspoken to until the host's
    // hello timeout closed it, and that close would stand up another.
    child.emitMessage({
      type: "paseo_frame",
      data: JSON.stringify({ type: "session", message: { type: "ping" } }),
      isBinary: false,
    });
    expect(sessions.active.size).toBe(0);

    child.emitMessage({
      type: "paseo_frame",
      data: JSON.stringify({
        type: "hello",
        clientId: "plugin:lazy-reattach",
        clientType: "cli",
        protocolVersion: 1,
      }),
      isBinary: false,
    });
    await sessions.waitForHellos(1);

    expect(sessions.active.size).toBe(1);
    expect([...sessions.active][0]).not.toBe(first);
    await runtime.stopAll();
    expect(sessions.active.size).toBe(0);
  });

  it("attaches no replacement session when the plugin is stopped", async () => {
    const directory = await createPlugin(
      "stopping",
      `export default function contribute(plugin: unknown) { void plugin; return () => undefined; }`,
    );
    const sessions = createTrackedSessionHost();
    const runtime = createTestRuntime({ sessionHost: sessions.host });
    await runtime.startPlugin("stopping", directory);
    expect(sessions.active.size).toBe(1);

    await runtime.stopPluginById("stopping");

    expect(runtime.getLogs("stopping").map((entry) => entry.message)).not.toContain(
      "[paseo] Re-attached plugin session",
    );
    expect(sessions.active.size).toBe(0);
  });
  it("closes an in-flight replacement when the plugin stops before attachment completes", async () => {
    const directory = await createPlugin(
      "stopping-redial",
      `export default function contribute() { return () => undefined; }`,
    );
    const child = createReloadChild("stopping-redial", []);
    const sessions = createTrackedSessionHost();
    let finishAttachment!: () => void;
    const attachmentHeld = new Promise<void>((resolve) => {
      finishAttachment = resolve;
    });
    let replacementAttached!: (socket: PluginSessionSocket) => void;
    const replacementStarted = new Promise<PluginSessionSocket>((resolve) => {
      replacementAttached = resolve;
    });
    let attachments = 0;
    const runtime = createTestRuntime({
      spawnChild: () => child,
      sessionHost: {
        async attachPluginSocket(pluginId, socket) {
          const attachment = await sessions.host.attachPluginSocket(pluginId, socket);
          attachments += 1;
          if (attachments === 2) {
            replacementAttached(socket);
            await attachmentHeld;
          }
          return attachment;
        },
      },
    });
    try {
      await runtime.startPlugin("stopping-redial", directory);
      const first = [...sessions.active][0] as PluginSessionSocket;
      first.close();
      child.emitMessage({
        type: "paseo_frame",
        data: JSON.stringify({ type: "hello" }),
        isBinary: false,
      });
      const replacement = await replacementStarted;
      const replacementClosed = new Promise<void>((resolve) => replacement.once("close", resolve));
      await runtime.stopPluginById("stopping-redial");
      finishAttachment();
      await replacementClosed;
      expect(sessions.active.size).toBe(0);
      expect(sessions.hellos).toEqual([]);
      expect(runtime.catalog()).toEqual([]);
      child.emitMessage({
        type: "paseo_frame",
        data: JSON.stringify({ type: "hello" }),
        isBinary: false,
      });
      expect(attachments).toBe(2);
    } finally {
      finishAttachment();
      await runtime.stopAll();
    }
  });
});

it("rejects a usage source without discovery at registration", async () => {
  const directory = await createPlugin(
    "missing-discovery",
    `
export default function contribute(server) {
  server.registerUsageSource({
    id: "missing-discovery",
    label: "Missing discovery",
    input: { parseAsync: async (value) => value },
    fetch: async () => ({ status: "available", windows: [] }),
  });
  return () => {};
}
`,
  );
  const runtime = createTestRuntime();
  try {
    await expect(runtime.startPlugin("missing-discovery", directory)).rejects.toThrow(
      "Invalid usage source: missing-discovery",
    );
  } finally {
    await runtime.stopAll();
  }
});

const examplesDirectory = fileURLToPath(
  new URL("../../../../../plugin-examples/", import.meta.url),
);
// The Markdown example owns npm preparation in the real app fixture:
// packages/app/e2e/browser/plugin-file-panel-examples.spec.ts.
const examples = (await readdir(examplesDirectory, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory() && entry.name !== "markdown-panel")
  .map((entry) => entry.name);

it.each(examples)("builds and loads the %s plugin example", async (example) => {
  const settingsDirectory = await mkdtemp(path.join(tmpdir(), "paseo-example-settings-"));
  temporaryDirectories.push(settingsDirectory);
  const runtime = createTestRuntime(
    { settingsDirectory },
    undefined,
    resolveDaemonVersion(import.meta.url),
  );
  try {
    await runtime.startPlugin(example, path.join(examplesDirectory, example));
    expect(runtime.catalog()).toMatchObject([{ id: example }]);
    expect(pluginMessages(runtime, example)).toContain("[paseo] Plugin ready");
  } finally {
    await runtime.stopAll();
  }
});

it("does not initialize a plugin cancelled during compilation", async () => {
  const directory = await createPlugin("cancelled-build", "export default () => {};");
  const marker = path.join(directory, "initialized.txt");
  await writeFile(
    path.join(directory, "index.server.ts"),
    `
import { writeFileSync } from "node:fs";
export default function contribute() {
  writeFileSync(${JSON.stringify(marker)}, "initialized");
  return () => {};
}`,
  );
  const runtime = createTestRuntime();
  let allowed = true;
  try {
    const loading = runtime.startPlugin("cancelled-build", directory, () => allowed);
    allowed = false;
    await expect(loading).rejects.toThrow("Plugin start cancelled: cancelled-build");
    expect(await readTextIfPresent(marker)).toBeNull();
    expect(runtime.catalog()).toEqual([]);
  } finally {
    await runtime.stopAll();
  }
});

describe("VCS plugin runtime", () => {
  it.each(
    [
      { mode: "subprocess", history: true },
      { mode: "in-process", history: true },
      { mode: "subprocess", history: false },
      { mode: "in-process", history: false },
    ].flatMap((entry) =>
      [true, false].map((diff) => ({ mode: entry.mode, history: entry.history, diff })),
    ),
  )(
    "supports a read-only VCS in $mode with history=$history diff=$diff",
    async ({ mode, history, diff }) => {
      const directory = await createPlugin(
        "readonly-vcs",
        `
export default function contribute(server) {
  server.registerVcsProvider({
    id: "readonly", label: "Read only",
    async detect(cwd) { return { status: "available", binding: { providerId: "readonly", repositoryId: "repo", workingCopyId: cwd, root: cwd, cwd } }; },
    async snapshot(binding) { return { binding, version: "1", current: { id: "revision", parents: [], description: "Read only", author: {name: "", email: ""}, timestamp: "", conflict: false }, files: [], refs: [], capabilities: ${JSON.stringify([...(history ? ["history"] : []), ...(diff ? ["diff"] : [])])}, actions: [], state: "ready" }; },
    ${history ? "async history() { return { revisions: [] }; }," : ""}
    ${diff ? 'async diff() { return "read-only patch"; },' : ""}
    workingCopies: {
      async create(binding, input) { return { binding: { ...binding, workingCopyId: input.root, root: input.root, cwd: input.root }, owned: true }; },
      async rollback() {},
    },
  });
  return () => {};
}`,
      );
      const runtime = createTestRuntime({ spawnChild: () => spawnObservedPluginProcess(() => {}) });
      try {
        if (mode === "in-process")
          await runtime.startBuiltinPlugin({ id: "readonly-vcs", directory });
        else await runtime.startPlugin("readonly-vcs", directory);
        const { VcsResponseSchema } = await import("@getpaseo/plugin");
        const invoke = async (request: import("@getpaseo/plugin").VcsRequest) =>
          VcsResponseSchema.parse(
            await runtime.invoke("readonly-vcs", "vcs.readonly.request", request),
          );
        const detected = await invoke({ kind: "detect", cwd: directory });
        if (detected.kind !== "detect" || detected.detection.status !== "available")
          throw new Error("Missing binding");
        const binding = detected.detection.binding;
        expect(await invoke({ kind: "snapshot", binding })).toMatchObject({
          kind: "snapshot",
          snapshot: { actions: [{ id: "working-copy.create", enabled: true }] },
        });
        expect(await invoke({ kind: "history", binding, limit: 10 })).toMatchObject(
          history
            ? { kind: "history", revisions: [] }
            : { kind: "error", error: { code: "unavailable" } },
        );
        expect(
          await invoke({
            kind: "diff",
            binding,
            comparison: { kind: "revision", revision: "revision" },
          }),
        ).toMatchObject(
          diff
            ? { kind: "diff", patch: "read-only patch" }
            : { kind: "error", error: { code: "unavailable" } },
        );
        const request = {
          kind: "execute" as const,
          binding,
          version: "1",
          operationId: "unsupported",
          action: "rewrite",
          input: null,
        };
        await invoke(request);
        await expect
          .poll(() => invoke({ kind: "operation", operationId: request.operationId }))
          .toMatchObject({
            kind: "operation",
            operation: { status: "failed", error: { code: "unavailable" } },
          });
        await invoke(request);
        await invoke({
          ...request,
          operationId: "copy",
          action: "working-copy.create",
          input: { root: path.join(directory, "copy"), name: "copy", revision: "revision" },
        });
        await expect
          .poll(() => invoke({ kind: "operation", operationId: "copy" }))
          .toMatchObject({
            kind: "operation",
            operation: { status: "succeeded", result: { owned: true } },
          });
        await runtime.stopPluginById("readonly-vcs");
        expect(runtime.getVcsProviderRegistrations("readonly-vcs")).toEqual([]);
      } finally {
        await runtime.stopAll();
      }
    },
  );
  it("runs the checkpoint-vcs example in a subprocess with frozen reads and durable history", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "paseo-checkpoint-example-"));
    temporaryDirectories.push(cwd);
    await mkdir(path.join(cwd, ".paseo-checkpoints"));
    await mkdir(path.join(cwd, "sub"));
    await writeFile(path.join(cwd, "note.txt"), "First\n");
    const runtime = createTestRuntime(
      { spawnChild: () => spawnObservedPluginProcess(() => {}) },
      undefined,
      resolveDaemonVersion(import.meta.url),
    );
    const { VcsResponseSchema } = await import("@getpaseo/plugin");
    const invoke = async (request: import("@getpaseo/plugin").VcsRequest) =>
      VcsResponseSchema.parse(
        await runtime.invoke("checkpoint-vcs", "vcs.checkpoint-vcs.request", request),
      );
    try {
      await runtime.startPlugin("checkpoint-vcs", path.join(examplesDirectory, "checkpoint-vcs"));
      const detection = await invoke({ kind: "detect", cwd: path.join(cwd, "sub") });
      if (detection.kind !== "detect" || detection.detection.status !== "available")
        throw new Error("Missing example binding");
      const binding = detection.detection.binding;
      expect(binding).toMatchObject({
        root: cwd,
        cwd: path.join(cwd, "sub"),
        providerId: "checkpoint-vcs",
      });
      const initial = await invoke({ kind: "snapshot", binding });
      if (initial.kind !== "snapshot" || !initial.snapshot.workingComparison)
        throw new Error("Missing example snapshot");
      expect(initial.snapshot.files).toEqual([
        { path: "note.txt", status: "added", conflict: false },
      ]);
      await writeFile(path.join(cwd, "note.txt"), "Second\n");
      expect(
        await invoke({ kind: "diff", binding, comparison: initial.snapshot.workingComparison }),
      ).toMatchObject({ kind: "diff", patch: expect.stringContaining("+First\n") });
      const stale = {
        kind: "execute" as const,
        binding,
        operationId: "stale",
        version: initial.snapshot.version,
        action: "checkpoint.create",
        input: { description: "First checkpoint" },
      };
      await invoke(stale);
      await expect
        .poll(() => invoke({ kind: "operation", operationId: "stale" }))
        .toMatchObject({
          kind: "operation",
          operation: { status: "failed", error: { code: "outdated" } },
        });
      const current = await invoke({ kind: "snapshot", binding });
      if (current.kind !== "snapshot") throw new Error("Missing current snapshot");
      const create = { ...stale, operationId: "checkpoint", version: current.snapshot.version };
      await invoke({ ...create, operationId: "invalid", input: { description: " " } });
      await expect
        .poll(() => invoke({ kind: "operation", operationId: "invalid" }))
        .toMatchObject({ kind: "operation", operation: { status: "failed" } });
      expect(
        await readTextIfPresent(path.join(cwd, ".paseo-checkpoints", "history.json")),
      ).toBeNull();
      await invoke(create);
      await expect
        .poll(() => invoke({ kind: "operation", operationId: "checkpoint" }))
        .toMatchObject({ kind: "operation", operation: { status: "succeeded" } });
      await invoke(create);
      const history = await invoke({ kind: "history", binding, limit: 10 });
      if (history.kind !== "history") throw new Error("Missing example history");
      expect(history.revisions).toHaveLength(1);
      expect(history.revisions[0]).toMatchObject({ description: "First checkpoint", parents: [] });
      expect(
        await invoke({ kind: "history", binding, limit: 1, version: initial.snapshot.version }),
      ).toEqual({ kind: "history", revisions: [] });
      await writeFile(path.join(cwd, "note.txt"), "Unsaved\n");
      const copyRoot = path.join(cwd, "copy");
      const copySnapshot = await invoke({ kind: "snapshot", binding });
      if (copySnapshot.kind !== "snapshot") throw new Error("Missing copy snapshot");
      const copyRequest = {
        kind: "execute" as const,
        binding,
        version: copySnapshot.snapshot.version,
        operationId: "copy",
        action: "working-copy.create",
        input: { root: copyRoot, name: "copy", revision: history.revisions[0]!.id },
      };
      await invoke(copyRequest);
      await expect
        .poll(() => invoke({ kind: "operation", operationId: "copy" }))
        .toMatchObject({
          kind: "operation",
          operation: { status: "succeeded" },
        });
      await invoke(copyRequest);
      await invoke({ ...copyRequest, operationId: "existing-copy" });
      await expect
        .poll(() => invoke({ kind: "operation", operationId: "existing-copy" }))
        .toMatchObject({
          kind: "operation",
          operation: { status: "failed" },
        });
      await invoke({
        ...copyRequest,
        operationId: "missing-revision",
        input: { ...copyRequest.input, root: path.join(cwd, "invalid-copy"), revision: "missing" },
      });
      await expect
        .poll(() => invoke({ kind: "operation", operationId: "missing-revision" }))
        .toMatchObject({
          kind: "operation",
          operation: { status: "failed", error: { code: "outdated" } },
        });
      expect(await readdir(cwd)).not.toContain("invalid-copy");
      const copied = await invoke({ kind: "operation", operationId: "copy" });
      if (copied.kind !== "operation") throw new Error("Missing copy operation");
      const { VcsWorkingCopyRecordSchema } = await import("@getpaseo/plugin");
      const record = VcsWorkingCopyRecordSchema.parse(copied.operation.result);
      expect(record).toMatchObject({ owned: true, binding: { root: copyRoot, repositoryId: cwd } });
      expect(await readFile(path.join(copyRoot, "note.txt"), "utf8")).toBe("Second\n");
      await mkdir(path.join(copyRoot, "sub"));
      await writeFile(path.join(copyRoot, "note.txt"), "Recovery edit\n");
      const recoveryRecord = {
        ...record,
        binding: { ...record.binding, cwd: path.join(copyRoot, "sub") },
      };
      const recover = async (
        operation: "prepare-removal" | "remove" | "restore" | "release",
        input: import("@getpaseo/plugin").VcsWorkingCopyRecord,
        operationId: string,
        status: "succeeded" | "failed" = "succeeded",
      ) => {
        const request = {
          kind: "working-copy.recovery" as const,
          operation,
          record: input,
          operationId,
        };
        await invoke(request);
        await expect
          .poll(() => invoke({ kind: "operation", operationId }))
          .toMatchObject({ kind: "operation", operation: { status } });
        await invoke(request);
        const response = await invoke({ kind: "operation", operationId });
        if (response.kind !== "operation") throw new Error("Missing recovery operation");
        return response.operation;
      };
      await writeFile(path.join(copyRoot, "ignored.txt"), "keep");
      expect(
        await recover("prepare-removal", recoveryRecord, "unpreserved", "failed"),
      ).toMatchObject({ error: { code: "conflict" } });
      await rm(path.join(copyRoot, "ignored.txt"));
      const prepared = VcsWorkingCopyRecordSchema.parse(
        (await recover("prepare-removal", recoveryRecord, "prepare")).result,
      );
      await writeFile(path.join(copyRoot, "note.txt"), "racing edit");
      expect(await recover("remove", prepared, "changed", "failed")).toMatchObject({
        error: { code: "outdated" },
      });
      expect(await readFile(path.join(copyRoot, "note.txt"), "utf8")).toBe("racing edit");
      await writeFile(path.join(copyRoot, "note.txt"), "Recovery edit\n");
      // Exercise the same JSON round trip as the durable registry before deleting the copy.
      const recoveryFile = path.join(cwd, "recovery.json");
      await writeFile(recoveryFile, JSON.stringify(prepared));
      await recover("remove", prepared, "remove");
      expect(await readdir(cwd)).not.toContain("copy");
      await runtime.stopPluginById("checkpoint-vcs");
      await runtime.startPlugin("checkpoint-vcs", path.join(examplesDirectory, "checkpoint-vcs"));
      const persisted = VcsWorkingCopyRecordSchema.parse(
        JSON.parse(await readFile(recoveryFile, "utf8")),
      );
      // The host shares recovery data with every workspace referencing this root.
      persisted.binding.cwd = copyRoot;
      expect(await invoke({ kind: "working-copy.inspect", record: persisted })).toEqual({
        kind: "working-copy.inspect",
      });
      await mkdir(copyRoot);
      await writeFile(path.join(copyRoot, "foreign.txt"), "keep");
      await recover("restore", persisted, "occupied", "failed");
      expect(await readFile(path.join(copyRoot, "foreign.txt"), "utf8")).toBe("keep");
      await rm(copyRoot, { recursive: true });
      const restored = VcsWorkingCopyRecordSchema.parse(
        (await recover("restore", persisted, "restore")).result,
      );
      expect(restored.binding.cwd).toBe(copyRoot);
      expect(await readdir(path.join(copyRoot, "sub"))).toEqual([]);
      expect(await readFile(path.join(copyRoot, "note.txt"), "utf8")).toBe("Recovery edit\n");
      expect(await invoke({ kind: "history", binding: restored.binding, limit: 10 })).toEqual(
        history,
      );
      const released = VcsWorkingCopyRecordSchema.parse(
        (await recover("release", restored, "release")).result,
      );
      expect(released.recovery).toBeUndefined();
      await writeFile(path.join(copyRoot, "note.txt"), "Edited after recovery\n");
      await writeFile(path.join(copyRoot, "new-file.txt"), "Keep new local files");
      const shared = {
        ...released,
        binding: { ...released.binding, cwd: path.join(copyRoot, "sub") },
      };
      const reopened = VcsWorkingCopyRecordSchema.parse(
        (await recover("restore", shared, "unarchive-shared")).result,
      );
      expect(reopened.binding.cwd).toBe(path.join(copyRoot, "sub"));
      expect(await readFile(path.join(copyRoot, "note.txt"), "utf8")).toBe(
        "Edited after recovery\n",
      );
      expect(await readFile(path.join(copyRoot, "new-file.txt"), "utf8")).toBe(
        "Keep new local files",
      );
      await recover("restore", { ...shared, state: "restoring" }, "partial-shared", "failed");
      await rm(path.join(copyRoot, "new-file.txt"));
      await rm(path.join(copyRoot, "note.txt"));
      const deleted = VcsWorkingCopyRecordSchema.parse(
        (await recover("prepare-removal", released, "prepare-deletion")).result,
      );
      await recover("remove", deleted, "remove-deletion");
      const restoredDeletion = VcsWorkingCopyRecordSchema.parse(
        (await recover("restore", deleted, "restore-deletion")).result,
      );
      expect(await readdir(copyRoot)).not.toContain("note.txt");
      expect(await invoke({ kind: "snapshot", binding: restoredDeletion.binding })).toMatchObject({
        kind: "snapshot",
        snapshot: { files: [{ path: "note.txt", status: "deleted", conflict: false }] },
      });
      await recover("release", restoredDeletion, "release-deletion");
      await rm(path.join(copyRoot, "sub"), { recursive: true });
      await writeFile(path.join(copyRoot, "note.txt"), "Second\n");
      await runtime.stopPluginById("checkpoint-vcs");
      await runtime.startPlugin("checkpoint-vcs", path.join(examplesDirectory, "checkpoint-vcs"));
      expect(await invoke({ kind: "detect", cwd: copyRoot })).toMatchObject({
        kind: "detect",
        detection: { binding: record.binding },
      });
      const rollback = { kind: "working-copy.rollback" as const, binding, record };
      await writeFile(path.join(copyRoot, "foreign.txt"), "keep");
      expect(await invoke(rollback)).toMatchObject({ kind: "error" });
      expect(await readFile(path.join(copyRoot, "foreign.txt"), "utf8")).toBe("keep");
      await rm(path.join(copyRoot, "foreign.txt"));
      await writeFile(path.join(copyRoot, "note.txt"), "edited");
      expect(await invoke(rollback)).toMatchObject({ kind: "error" });
      expect(await readFile(path.join(copyRoot, "note.txt"), "utf8")).toBe("edited");
      await writeFile(path.join(copyRoot, "note.txt"), "Second\n");
      expect(await invoke(rollback)).toEqual({ kind: "working-copy.rollback" });
      expect(await readdir(cwd)).not.toContain("copy");
      expect(await readFile(path.join(cwd, "note.txt"), "utf8")).toBe("Unsaved\n");
      await writeFile(path.join(cwd, "note.txt"), "Second\n");
      expect(await invoke({ kind: "snapshot", binding })).toMatchObject({
        kind: "snapshot",
        snapshot: {
          files: [],
          actions: expect.arrayContaining([
            expect.objectContaining({ id: "checkpoint.create", enabled: false }),
          ]),
        },
      });
      await runtime.stopPluginById("checkpoint-vcs");
      expect(runtime.getVcsProviderRegistrations("checkpoint-vcs")).toEqual([]);
      await runtime.startPlugin("checkpoint-vcs", path.join(examplesDirectory, "checkpoint-vcs"));
      expect(await invoke({ kind: "history", binding, limit: 10 })).toEqual(history);
      expect(
        await invoke({ kind: "diff", binding, comparison: initial.snapshot.workingComparison }),
      ).toMatchObject({ kind: "error", error: { code: "outdated" } });
      // Historical reads must not depend on the current file being valid text.
      await writeFile(path.join(cwd, "note.txt"), "\0");
      expect(
        await invoke({
          kind: "diff",
          binding,
          comparison: { kind: "revision", revision: history.revisions[0]!.id },
        }),
      ).toMatchObject({ kind: "diff", patch: expect.stringContaining("+Second\n") });
    } finally {
      await runtime.stopAll();
    }
  });
  it.each(["subprocess", "in-process"])(
    "loads a VCS in %s and removes its registration on unload",
    async (mode) => {
      const directory = await createPlugin(
        "vcs-fixture",
        `
import type { PluginServerContext } from '@getpaseo/plugin/server';
import { VcsError } from '@getpaseo/plugin/server/vcs';
export default function contribute(server: PluginServerContext) {
  let creations = 0;
  server.registerVcsProvider({
    id: 'fixture', label: 'Fixture',
    async validateComparisonSettings(_binding, value) { if (value.version !== 7) throw new VcsError({code: 'outdated', message: 'Unsupported settings version'}); return value; },
    publication: {
      async remotes() { return [{ name: 'origin', fetchUrl: 'https://forge.test/repo', pushUrls: ['https://forge.test/repo'] }]; },
      async resolve(_binding, selection) { return { ...selection, repositoryUrl: 'https://forge.test/repo', headRevision: 'revision' }; },
      async publish(_binding, target) { return target; },
      async verify() {},
    },
    workingCopies: {
      async resolveSource(_binding, input) {
        if (input.version !== 3 || input.data !== 'label') throw new VcsError({ code: 'outdated', message: 'Select a known label' });
        return { revision: 'revision', data: { version: 1, data: 'custom' } };
      },
      async create(binding, input) { if (input.data?.version !== 1 || input.data.data !== 'custom') throw new Error('Missing provider options'); creations++; return { binding: { ...binding, root: input.root, cwd: input.root }, owned: true, data: { version: 1, data: creations } }; },
      async rollback() {},
    },
    async detect(cwd) { return { status: 'available', binding: { providerId: 'fixture', repositoryId: 'repo', workingCopyId: 'copy', root: cwd, cwd } }; },
    async snapshot(binding) { if (binding.cwd.endsWith('/unsupported')) throw new VcsError({ code: 'unsupported-version', message: 'Update the VCS executable' }); return { binding, version: '1', current: { id: 'revision', parents: [], description: '', author: { name: '', email: '' }, timestamp: '', conflict: false }, files: [], refs: [], capabilities: ['actions'], actions: [{ id: 'fail', enabled: true }], state: 'ready' }; },
    async history() { return { revisions: [] }; },
    async diff() { return 'patch'; },
    async previewAction(_binding, _action, input, context) { return { revisions: [context.snapshot.current], files: [input.file], refs: [] }; },
    async execute() { throw new VcsError({ code: 'conflict', message: 'Resolve conflicts first' }); },
  });
  return () => {};
}`,
      );
      const runtime = createTestRuntime({ spawnChild: () => spawnObservedPluginProcess(() => {}) });
      try {
        if (mode === "in-process")
          await runtime.startBuiltinPlugin({ id: "vcs-fixture", directory });
        else await runtime.startPlugin("vcs-fixture", directory);
        expect(runtime.getVcsProviderRegistrations("vcs-fixture")).toEqual([
          { id: "fixture", label: "Fixture" },
        ]);
        const { VcsResponseSchema } = await import("@getpaseo/plugin");
        const invoke = async (input: unknown) =>
          VcsResponseSchema.parse(
            await runtime.invoke("vcs-fixture", "vcs.fixture.request", input),
          );
        const detection = await invoke({ kind: "detect", cwd: directory });
        expect(detection.kind).toBe("detect");
        if (detection.kind !== "detect" || detection.detection.status !== "available")
          throw new Error("Missing binding");
        const binding = detection.detection.binding;
        expect(
          await invoke({
            kind: "actions.preview",
            binding,
            version: "1",
            action: "fail",
            input: { file: "selected.txt" },
          }),
        ).toMatchObject({
          kind: "actions.preview",
          preview: { revisions: [{ id: "revision" }], files: ["selected.txt"], refs: [] },
        });
        expect(
          await invoke({
            kind: "actions.preview",
            binding,
            version: "old",
            action: "fail",
            input: { file: "selected.txt" },
          }),
        ).toMatchObject({ kind: "error", error: { code: "outdated" } });

        expect(
          await invoke({
            kind: "comparison-settings.validate",
            binding,
            value: { version: 7, data: "custom" },
          }),
        ).toEqual({ kind: "comparison-settings", value: { version: 7, data: "custom" } });
        expect(
          await invoke({ kind: "comparison-settings.validate", binding, value: null }),
        ).toEqual({ kind: "comparison-settings", value: null });
        expect(
          await invoke({
            kind: "comparison-settings.validate",
            binding,
            value: { version: 99, data: null },
          }),
        ).toMatchObject({ kind: "error", error: { code: "outdated" } });
        expect(
          await invoke({
            kind: "working-copy.resolve-source",
            binding,
            input: { version: 3, data: "label" },
          }),
        ).toEqual({
          kind: "working-copy.source",
          source: { revision: "revision", data: { version: 1, data: "custom" } },
        });
        expect(
          await invoke({
            kind: "working-copy.resolve-source",
            binding,
            input: { version: 99, data: "label" },
          }),
        ).toMatchObject({
          kind: "error",
          error: { code: "outdated", message: "Select a known label" },
        });
        const unsupported = await invoke({ kind: "detect", cwd: directory + "/unsupported" });
        if (unsupported.kind !== "detect" || unsupported.detection.status !== "available")
          throw new Error("Missing error fixture binding");
        expect(await invoke({ kind: "snapshot", binding: unsupported.detection.binding })).toEqual({
          kind: "error",
          error: { code: "unsupported-version", message: "Update the VCS executable" },
        });
        expect(
          await invoke({ kind: "diff", binding, comparison: { kind: "working-copy" } }),
        ).toEqual({ kind: "diff", patch: "patch" });
        const publication = {
          remote: "origin",
          headRef: "feature",
          baseRef: "main",
          repositoryUrl: "https://forge.test/repo",
          headRevision: "revision",
        };
        expect(
          await invoke({
            kind: "publication.resolve",
            binding,
            selection: { remote: "origin", headRef: "feature", baseRef: "main" },
          }),
        ).toEqual({ kind: "publication", publication });
        await invoke({
          kind: "publication.publish",
          binding,
          target: publication,
          operationId: "publication",
        });
        await expect
          .poll(() => invoke({ kind: "operation", operationId: "publication" }))
          .toEqual({
            kind: "operation",
            operation: { id: "publication", status: "succeeded", result: publication },
          });
        const request = {
          kind: "execute",
          binding,
          operationId: "failure",
          version: "1",
          action: "fail",
          input: {},
        };
        await invoke(request);
        await expect
          .poll(() => invoke({ kind: "operation", operationId: "failure" }))
          .toEqual({
            kind: "operation",
            operation: {
              id: "failure",
              status: "failed",
              error: { code: "conflict", message: "Resolve conflicts first" },
            },
          });
        await expect(invoke({ ...request, action: "different" })).rejects.toThrow(
          "Operation ID was already used",
        );
        expect(await invoke({ kind: "operation", operationId: "missing" })).toEqual({
          kind: "operation",
          operation: { id: "missing", status: "unknown" },
        });
        const creation = {
          ...request,
          operationId: "create",
          action: "working-copy.create",
          input: {
            root: directory + "/new",
            name: "new",
            revision: "revision",
            data: { version: 1, data: "custom" },
          },
        };
        await Promise.all([invoke(creation), invoke(creation)]);
        await expect
          .poll(() => invoke({ kind: "operation", operationId: "create" }))
          .toMatchObject({
            operation: {
              status: "succeeded",
              result: { owned: true, data: { version: 1, data: 1 } },
            },
          });
        const created = await invoke({ kind: "operation", operationId: "create" });
        if (created.kind !== "operation") throw new Error("Missing operation");
        expect(
          await invoke({
            kind: "working-copy.rollback",
            binding,
            record: created.operation.result,
          }),
        ).toEqual({ kind: "working-copy.rollback" });
        await runtime.stopPluginById("vcs-fixture");
        expect(runtime.getVcsProviderRegistrations("vcs-fixture")).toEqual([]);
        await expect(invoke({ kind: "detect", cwd: directory })).rejects.toThrow();
      } finally {
        await runtime.stopAll();
      }
    },
  );

  it("reads and mutates real jj working copies through the shared executor", async () => {
    const { execCommand } = await import("@getpaseo/plugin/server");
    const { createVcsHandler } = await import("@getpaseo/plugin/server/vcs");
    const { jjProvider } = await import("../../../../../plugins/jj-vcs/server/provider.js");
    const cwd = await mkdtemp(path.join(tmpdir(), "paseo-vcs-jj-"));
    temporaryDirectories.push(cwd);
    await execCommand("jj", ["git", "init", cwd]);
    await writeFile(path.join(cwd, "a.txt"), "first\n");
    await writeFile(path.join(cwd, "b.txt"), "second\n");
    const handler = createVcsHandler(jjProvider);
    try {
      const detection = await handler.handle({ kind: "detect", cwd });
      if (detection.kind !== "detect" || detection.detection.status !== "available")
        throw new Error(JSON.stringify(detection));
      const binding = detection.detection.binding;
      const snapshot = await handler.handle({ kind: "snapshot", binding });
      if (snapshot.kind !== "snapshot") throw new Error("Missing snapshot");
      expect(snapshot.snapshot.files).toEqual([
        { path: "a.txt", status: "added", conflict: false },
        { path: "b.txt", status: "added", conflict: false },
      ]);
      const diff = await handler.handle({
        kind: "diff",
        binding,
        comparison: { kind: "working-copy" },
      });
      expect(diff.kind === "diff" && diff.patch).toContain("+first");
      const execute = {
        kind: "execute" as const,
        binding,
        operationId: "describe",
        version: snapshot.snapshot.version,
        action: "describe",
        input: { revision: snapshot.snapshot.current!.id, message: "A description" },
      };
      await Promise.all([handler.handle(execute), handler.handle(execute)]);
      await expect
        .poll(() => handler.handle({ kind: "operation", operationId: "describe" }))
        .toMatchObject({ operation: { status: "succeeded" } });
      const after = await handler.handle({ kind: "snapshot", binding });
      expect(after).toMatchObject({
        kind: "snapshot",
        snapshot: { current: { description: "A description\n" } },
      });
      expect(snapshot.snapshot.workingComparison).toEqual({
        kind: "revision",
        revision: snapshot.snapshot.current!.id,
      });
      const operationBeforeReads = (
        await execCommand(
          "jj",
          ["op", "log", "--ignore-working-copy", "--no-graph", "--limit", "1", "-T", "id"],
          { cwd },
        )
      ).stdout;
      const pinned = await handler.handle({
        kind: "history",
        binding,
        limit: 1,
        version: snapshot.snapshot.version,
      });
      expect(pinned).toMatchObject({
        kind: "history",
        revisions: [{ id: snapshot.snapshot.current!.id, description: "" }],
      });
      await writeFile(path.join(cwd, "a.txt"), "not snapshotted by reads\n");
      const pinnedDiff = await handler.handle({
        kind: "diff",
        binding,
        comparison: snapshot.snapshot.workingComparison!,
      });
      expect(pinnedDiff.kind === "diff" && pinnedDiff.patch).toContain("+first");
      expect(
        (
          await execCommand(
            "jj",
            ["op", "log", "--ignore-working-copy", "--no-graph", "--limit", "1", "-T", "id"],
            { cwd },
          )
        ).stdout,
      ).toBe(operationBeforeReads);
      await handler.handle({ ...execute, operationId: "outdated" });
      await expect
        .poll(() => handler.handle({ kind: "operation", operationId: "outdated" }))
        .toMatchObject({ operation: { status: "failed", error: { code: "outdated" } } });
      expect(await handler.handle({ kind: "history", binding, limit: 1 })).toMatchObject({
        kind: "history",
        revisions: [{ description: "A description\n" }],
      });
    } finally {
      handler.dispose();
    }
  });
});

describe("VCS provider commands", () => {
  it.each(["git", "jj"])(
    "filters whitespace in pinned revision and range comparisons for %s",
    async (id) => {
      const { execCommand } = await import("@getpaseo/plugin/server");
      const { createVcsHandler } = await import("@getpaseo/plugin/server/vcs");
      const { gitProvider } = await import("../../../../../plugins/git-vcs/server/provider.js");
      const { jjProvider } = await import("../../../../../plugins/jj-vcs/server/provider.js");
      const { resolveGitRevisionComparison } =
        await import("../../../../../plugins/git-vcs/client/comparison.js");
      const { resolveJjRevisionComparison } =
        await import("../../../../../plugins/jj-vcs/client/comparison.js");
      const cwd = await mkdtemp(path.join(tmpdir(), "paseo-revision-comparison-"));
      temporaryDirectories.push(cwd);
      const git = (args: string[]) =>
        execCommand("git", ["-c", "commit.gpgsign=false", ...args], { cwd });
      await git(["init", "-b", "main"]);
      await git(["config", "user.name", "VCS Test"]);
      await git(["config", "user.email", "vcs@example.test"]);
      await writeFile(path.join(cwd, "space.txt"), "one two\n");
      await git(["add", "."]);
      await git(["commit", "-m", "Base"]);
      const from = (await git(["rev-parse", "HEAD"])).stdout.trim();
      await writeFile(path.join(cwd, "space.txt"), "one   two\n");
      await writeFile(path.join(cwd, "content.txt"), "content\n");
      await git(["add", "."]);
      await git(["commit", "-m", "Selected revision"]);
      const to = (await git(["rev-parse", "HEAD"])).stdout.trim();
      if (id === "jj") await execCommand("jj", ["git", "init", "--colocate"], { cwd });
      const handler = createVcsHandler(id === "git" ? gitProvider : jjProvider);
      const resolve = id === "git" ? resolveGitRevisionComparison : resolveJjRevisionComparison;
      try {
        const detection = await handler.handle({ kind: "detect", cwd });
        if (detection.kind !== "detect" || detection.detection.status !== "available")
          throw new Error(JSON.stringify(detection));
        const binding = detection.detection.binding;
        const response = await handler.handle({ kind: "snapshot", binding });
        if (response.kind !== "snapshot") throw new Error("Missing snapshot");
        const snapshot = response.snapshot;
        const index = await readFile(path.join(cwd, ".git/index"));
        await writeFile(path.join(cwd, "content.txt"), "unsnapshotted\n");
        for (const comparison of [
          { kind: "revision" as const, revision: to },
          { kind: "range" as const, from, to },
        ]) {
          const plain = resolve({ snapshot, comparison, ignoreWhitespace: false });
          const filtered = resolve({ snapshot, comparison, ignoreWhitespace: true });
          expect(plain).toEqual({ comparison });
          expect(filtered.reviewScope).not.toBe(plain.reviewScope);
          if (!filtered.comparison) throw new Error(filtered.error);
          const raw = await handler.handle({ kind: "diff", binding, comparison });
          const result = await handler.handle({
            kind: "diff",
            binding,
            comparison: filtered.comparison,
          });
          expect(raw).toMatchObject({ kind: "diff", patch: expect.stringContaining("+one   two") });
          expect(result).toMatchObject({
            kind: "diff",
            patch: expect.stringContaining("+content"),
          });
          if (result.kind !== "diff") throw new Error("Missing diff");
          expect(result.patch).not.toContain("+one   two");
          expect(result.patch).not.toContain("unsnapshotted");
        }
        expect(await readFile(path.join(cwd, ".git/index"))).toEqual(index);
        if (id === "jj") {
          const operation = await execCommand(
            "jj",
            ["--ignore-working-copy", "op", "log", "--no-graph", "-n", "1", "-T", "id"],
            { cwd },
          );
          expect(operation.stdout.trim()).toBe(snapshot.version);
        }
      } finally {
        handler.dispose();
      }
    },
  );
  it.each([
    {
      stderr: "Error: The working copy is stale (not updated since operation abc)\n",
      args: ["status"],
      code: "stale",
      recoveryAction: "update-stale",
    },
    { stderr: "Error: Revision `ffff` doesn't exist\n", args: ["describe"], code: "outdated" },
    { stderr: "Error: Ambiguous revision prefix: abc\n", args: ["edit"], code: "outdated" },
    {
      stderr: "Error: Won't push commit abc since it has conflicts\n",
      args: ["git", "push"],
      code: "conflict",
    },
    {
      stderr: "Error: Bookmark already exists: feature\n",
      args: ["bookmark", "create"],
      code: "conflict",
    },
    {
      stderr: "Error: Refusing to move bookmark backwards or sideways: feature\n",
      args: ["bookmark", "set"],
      code: "conflict",
    },
    {
      stderr: "Error: Connection refused\n",
      args: ["--at-op", "abc", "git", "push"],
      code: "remote",
    },
    { stderr: "Internal error: Corrupt object store\n", args: ["git", "fetch"], code: "provider" },
    {
      stderr: "Error: Won't push commit abc since it has no description\n",
      args: ["git", "push"],
      code: "conflict",
    },
    { stderr: "Config error: invalid value\n", args: ["git", "fetch"], code: "provider" },
    {
      stderr: "Error: Failed to snapshot the working copy\n",
      args: ["git", "push"],
      code: "provider",
    },
    { stderr: "Error: Internal ENOENT while reading object\n", args: ["log"], code: "provider" },
    {
      stderr: "Error: The root commit 000 is immutable\n",
      args: ["describe", "-m", "working copy is stale ENOENT git push"],
      code: "provider",
    },
  ])(
    "classifies jj diagnostics as $code: $stderr",
    async ({ stderr, args, code, recoveryAction }) => {
      const { classifyJjError } = await import("../../../../../plugins/jj-vcs/server/errors.js");
      const message = `Command failed: jj ${args.join(" ")}\n${stderr}`;
      const error = Object.assign(new Error(message), { code: 1, stderr });
      expect(classifyJjError(error, args, new AbortController().signal).problem).toEqual({
        code,
        message,
        ...(recoveryAction ? { recoveryAction } : {}),
      });
    },
  );

  it("distinguishes jj launch, cancellation and CLI failures from remote rejection", async () => {
    const { classifyJjError } = await import("../../../../../plugins/jj-vcs/server/errors.js");
    const controller = new AbortController();
    const missing = Object.assign(new Error("spawn jj ENOENT"), { code: "ENOENT", path: "jj" });
    expect(classifyJjError(missing, ["git", "fetch"], controller.signal).problem.code).toBe(
      "unavailable",
    );
    const syntax = Object.assign(new Error("bad CLI arguments"), {
      code: 2,
      stderr: "error: unexpected argument",
    });
    expect(classifyJjError(syntax, ["git", "fetch"], controller.signal).problem.code).toBe(
      "provider",
    );
    controller.abort();
    expect(classifyJjError(syntax, ["git", "fetch"], controller.signal).problem.code).toBe(
      "cancelled",
    );
  });

  it("classifies real jj conflicts and missing revisions through the operation executor", async () => {
    const { execCommand } = await import("@getpaseo/plugin/server");
    const { createVcsHandler } = await import("@getpaseo/plugin/server/vcs");
    const { jjProvider } = await import("../../../../../plugins/jj-vcs/server/provider.js");
    const root = await mkdtemp(path.join(tmpdir(), "paseo-jj-conflict-errors-"));
    temporaryDirectories.push(root);
    const cwd = path.join(root, "repo");
    const remote = path.join(root, "remote.git");
    await mkdir(cwd);
    const jj = async (...args: string[]) =>
      (
        await execCommand(
          "jj",
          ["--config", 'user.name="Test"', "--config", 'user.email="test@example.test"', ...args],
          { cwd },
        )
      ).stdout.trim();
    await execCommand("git", ["init", "--bare", remote]);
    await jj("git", "init");
    await writeFile(path.join(cwd, "a.txt"), "base\n");
    await jj("describe", "-m", "Base");
    const revision = async () => jj("log", "-r", "@", "--no-graph", "-T", "commit_id");
    const base = await revision();
    await jj("new", "-m", "Left");
    await writeFile(path.join(cwd, "a.txt"), "left\n");
    const left = await revision();
    await jj("new", base, "-m", "Right");
    await writeFile(path.join(cwd, "a.txt"), "right\n");
    const right = await revision();
    await jj("new", left, right, "-m", "Merge");
    await jj("bookmark", "create", "feature");
    await jj("git", "remote", "add", "origin", remote);
    const handler = createVcsHandler(jjProvider);
    try {
      const detection = await handler.handle({ kind: "detect", cwd });
      if (detection.kind !== "detect" || detection.detection.status !== "available")
        throw new Error("Missing binding");
      const binding = detection.detection.binding;
      const perform = async (
        action: string,
        input: import("@getpaseo/plugin").JsonValue,
        code: string,
      ) => {
        const state = await handler.handle({ kind: "snapshot", binding });
        if (state.kind !== "snapshot") throw new Error("Missing snapshot");
        await handler.handle({
          kind: "execute",
          binding,
          version: state.snapshot.version,
          action,
          input,
          operationId: action,
        });
        await expect
          .poll(() => handler.handle({ kind: "operation", operationId: action }))
          .toMatchObject({ operation: { status: "failed", error: { code } } });
      };
      await perform("push", { remote: "origin", name: "feature" }, "conflict");
      await perform("bookmark-create", { name: "feature", revision: left }, "conflict");
      await perform("describe", { revision: "f".repeat(40), message: "missing" }, "outdated");
      await perform("edit", { revision: "0".repeat(40) }, "provider");
      const state = await handler.handle({ kind: "snapshot", binding });
      expect(state).toMatchObject({
        snapshot: { current: { conflict: true }, files: [] },
      });
      expect((await execCommand("git", ["--git-dir", remote, "for-each-ref"])).stdout).toBe("");
    } finally {
      handler.dispose();
    }
  });

  it("classifies jj remote failures without losing command diagnostics", async () => {
    const { execCommand } = await import("@getpaseo/plugin/server");
    const { createVcsHandler } = await import("@getpaseo/plugin/server/vcs");
    const { jjProvider } = await import("../../../../../plugins/jj-vcs/server/provider.js");
    const cwd = await mkdtemp(path.join(tmpdir(), "paseo-jj-errors-"));
    temporaryDirectories.push(cwd);
    await execCommand("jj", ["git", "init"], { cwd });
    const missing = path.join(cwd, "missing-remote.git");
    await execCommand("jj", ["git", "remote", "add", "broken", missing], { cwd });
    const handler = createVcsHandler(jjProvider);
    try {
      const detection = await handler.handle({ kind: "detect", cwd });
      if (detection.kind !== "detect" || detection.detection.status !== "available")
        throw new Error("Missing binding");
      const binding = detection.detection.binding;
      const state = await handler.handle({ kind: "snapshot", binding });
      if (state.kind !== "snapshot") throw new Error("Missing snapshot");
      await handler.handle({
        kind: "execute",
        binding,
        version: state.snapshot.version,
        action: "fetch",
        input: { remote: "broken" },
        operationId: "fetch",
      });
      await expect
        .poll(() => handler.handle({ kind: "operation", operationId: "fetch" }))
        .toMatchObject({
          operation: {
            status: "failed",
            error: { code: "remote", message: expect.stringContaining(missing) },
          },
        });
    } finally {
      handler.dispose();
    }
  });

  it("previews jj rewrites with descendants and rejects execution after the confirmed snapshot changes", async () => {
    const { execCommand } = await import("@getpaseo/plugin/server");
    const { createVcsHandler } = await import("@getpaseo/plugin/server/vcs");
    const { jjProvider } = await import("../../../../../plugins/jj-vcs/server/provider.js");
    const cwd = await mkdtemp(path.join(tmpdir(), "paseo-jj-preview-"));
    temporaryDirectories.push(cwd);
    const jj = async (...args: string[]) => (await execCommand("jj", args, { cwd })).stdout.trim();
    await jj("git", "init");
    await writeFile(path.join(cwd, "a.txt"), "parent\n");
    await jj("describe", "-m", "Parent");
    const parent = await jj("log", "-r", "@", "--no-graph", "-T", "commit_id");
    await jj("new", "-m", "Child");
    const child = await jj("log", "-r", "@", "--no-graph", "-T", "commit_id");
    await jj("bookmark", "create", "affected", "-r", child);
    await jj("new", "-m", "Grandchild");
    await writeFile(path.join(cwd, "a.txt"), "grandchild\n");
    const grandchild = await jj("log", "-r", "@", "--no-graph", "-T", "commit_id");
    await jj("new", "root()", "-m", "Unrelated");
    const unrelated = await jj("log", "-r", "@", "--no-graph", "-T", "commit_id");
    await jj("edit", grandchild);
    const handler = createVcsHandler(jjProvider);
    try {
      const detection = await handler.handle({ kind: "detect", cwd });
      if (detection.kind !== "detect" || detection.detection.status !== "available")
        throw new Error("Missing binding");
      const binding = detection.detection.binding;
      const state = await handler.handle({ kind: "snapshot", binding });
      if (state.kind !== "snapshot") throw new Error("Missing snapshot");
      const version = state.snapshot.version;
      const preview = async (action: string, input: import("@getpaseo/plugin").JsonValue) => {
        const result = await handler.handle({
          kind: "actions.preview",
          binding,
          version,
          action,
          input,
        });
        if (result.kind !== "actions.preview") throw new Error(JSON.stringify(result));
        return result.preview;
      };
      for (const action of ["describe", "abandon", "rebase", "split"]) {
        const result = await preview(action, {
          revision: parent,
          destination: unrelated,
          files: ["a.txt"],
          message: "Rewrite",
        });
        expect(result.revisions.map((item) => item.id).sort()).toEqual(
          [parent, child, grandchild].sort(),
        );
        expect(result.refs.map((item) => item.name)).toEqual(["affected"]);
      }
      const squash = await preview("squash", {
        revision: grandchild,
        destination: parent,
        files: ["a.txt"],
      });
      expect(squash.revisions.map((item) => item.id).sort()).toEqual(
        [parent, child, grandchild].sort(),
      );
      const restore = await preview("restore", { revision: parent, files: ["a.txt"] });
      expect(restore.revisions.map((item) => item.id)).toEqual([grandchild]);
      expect(restore.files).toEqual(["a.txt"]);
      const bookmark = await preview("bookmark-delete", { name: "affected" });
      expect(bookmark.revisions).toEqual([]);
      expect(bookmark.refs.map((item) => item.name)).toEqual(["affected"]);
      expect(
        await jj("op", "log", "--ignore-working-copy", "--no-graph", "-n", "1", "-T", "id"),
      ).toBe(version);
      await jj("describe", "-m", "External rewrite");
      await expect(preview("abandon", { revision: parent })).rejects.toMatchObject({
        problem: { code: "outdated" },
      });
      await handler.handle({
        kind: "execute",
        binding,
        version,
        operationId: "confirmed",
        action: "abandon",
        input: { revision: parent },
      });
      await expect
        .poll(() => handler.handle({ kind: "operation", operationId: "confirmed" }))
        .toMatchObject({ operation: { status: "failed", error: { code: "outdated" } } });
      expect(await jj("log", "-r", parent, "--no-graph", "-T", "description")).toBe("Parent");
    } finally {
      handler.dispose();
    }
  });

  it("pins jj base comparisons across bookmark moves without snapshotting reads", async () => {
    const { execCommand } = await import("@getpaseo/plugin/server");
    const { createVcsHandler } = await import("@getpaseo/plugin/server/vcs");
    const { jjProvider } = await import("../../../../../plugins/jj-vcs/server/provider.js");
    const { resolveJjComparison } =
      await import("../../../../../plugins/jj-vcs/client/comparison.js");
    const cwd = await mkdtemp(path.join(tmpdir(), "paseo-jj-comparison-"));
    temporaryDirectories.push(cwd);
    const jj = (args: string[]) => execCommand("jj", args, { cwd });
    await jj(["git", "init"]);
    await writeFile(path.join(cwd, "space.txt"), "one two\n");
    await jj(["describe", "-m", "Base"]);
    await jj(["bookmark", "create", "base"]);
    await jj(["new"]);
    await writeFile(path.join(cwd, "ancestor.txt"), "ancestor\n");
    await jj(["new", "-m", "Current"]);
    await writeFile(path.join(cwd, "space.txt"), "one  two\n");
    const handler = createVcsHandler(jjProvider);
    try {
      const detected = await handler.handle({ kind: "detect", cwd });
      if (detected.kind !== "detect" || detected.detection.status !== "available")
        throw new Error(JSON.stringify(detected));
      const binding = detected.detection.binding;
      const response = await handler.handle({ kind: "snapshot", binding });
      if (response.kind !== "snapshot") throw new Error("Missing snapshot");
      const snapshot = response.snapshot;
      const baseRef = snapshot.refs.find((ref) => ref.name === "base")!.id;
      const comparison = (id: string, ignoreWhitespace: boolean) => {
        const result = resolveJjComparison({ snapshot, id, baseRef, ignoreWhitespace });
        if (!result.comparison) throw new Error(result.error);
        return result.comparison;
      };
      const diff = async (id: string, ignoreWhitespace: boolean) => {
        const result = await handler.handle({
          kind: "diff",
          binding,
          comparison: comparison(id, ignoreWhitespace),
        });
        if (result.kind !== "diff") throw new Error("Missing diff");
        return result.patch;
      };
      const basePatch = await diff("base", false);
      expect(basePatch).toContain("+ancestor");
      expect(basePatch).toContain("+one  two");
      expect(await diff("default", false)).not.toContain("ancestor.txt");
      expect(await diff("default", true)).not.toContain("@@");
      const filtered = await diff("base", true);
      expect(filtered).toContain("+ancestor");
      expect(filtered).not.toContain("+one  two");
      await jj(["bookmark", "set", "base", "-r", "@"]);
      await writeFile(path.join(cwd, "space.txt"), "unsnapshotted\n");
      const operation = () =>
        jj(["--ignore-working-copy", "op", "log", "--no-graph", "-n", "1", "-T", "id"]);
      const before = (await operation()).stdout;
      expect(await diff("base", false)).toBe(basePatch);
      expect((await operation()).stdout).toBe(before);
      expect(await readFile(path.join(cwd, "space.txt"), "utf8")).toBe("unsnapshotted\n");
      await expect(
        handler.handle({
          kind: "diff",
          binding,
          comparison: { kind: "working-copy", data: { version: 2, data: {} } },
        }),
      ).rejects.toThrow();
    } finally {
      handler.dispose();
    }
  });
  it("tracks only the selected exact jj remote bookmark and exposes tracking state", async () => {
    const { execCommand } = await import("@getpaseo/plugin/server");
    const { createVcsHandler } = await import("@getpaseo/plugin/server/vcs");
    const { jjProvider } = await import("../../../../../plugins/jj-vcs/server/provider.js");
    const root = await mkdtemp(path.join(tmpdir(), "paseo-jj-track-"));
    temporaryDirectories.push(root);
    const seed = path.join(root, "seed");
    const cwd = path.join(root, "repo");
    await execCommand("git", ["init", "-b", "main", seed]);
    await execCommand(
      "git",
      [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.test",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "--allow-empty",
        "-m",
        "Base",
      ],
      { cwd: seed },
    );
    const names = ["feature", "topic@review", 'topic"quoted', "topic(paren)", "тема"];
    for (const name of names) await execCommand("git", ["branch", name], { cwd: seed });
    await execCommand("jj", ["git", "init", cwd]);
    for (const remote of ["origin@mirror", "other"]) {
      await execCommand("jj", ["git", "remote", "add", remote, seed], { cwd });
      await execCommand(
        "jj",
        [
          "--config",
          "git.auto-local-bookmark=false",
          "git",
          "fetch",
          "--remote",
          `exact:${JSON.stringify(remote)}`,
        ],
        { cwd },
      );
    }
    const handler = createVcsHandler(jjProvider);
    try {
      const detection = await handler.handle({ kind: "detect", cwd });
      if (detection.kind !== "detect" || detection.detection.status !== "available")
        throw new Error("Missing binding");
      const binding = detection.detection.binding;
      const snapshot = async () => {
        const result = await handler.handle({ kind: "snapshot", binding });
        if (result.kind !== "snapshot") throw new Error("Missing snapshot");
        return result.snapshot;
      };
      for (const name of names) {
        const before = await snapshot();
        const request = {
          kind: "execute" as const,
          binding,
          version: before.version,
          operationId: name,
          action: "bookmark-track",
          input: { name, remote: "origin@mirror" },
        };
        await handler.handle(request);
        await expect
          .poll(() => handler.handle({ kind: "operation", operationId: name }))
          .toMatchObject({ operation: { status: "succeeded" } });
        const after = await snapshot();
        const target = after.refs.find(
          (ref) => ref.name === name && ref.remote === "origin@mirror",
        );
        expect(target).toMatchObject({ tracked: true });
        expect(after.refs.find((ref) => ref.name === name && !ref.remote)?.targets).toEqual(
          target?.targets,
        );
        expect(after.refs.find((ref) => ref.name === name && ref.remote === "other")).toMatchObject(
          { tracked: false },
        );
        expect(
          after.refs.find((ref) => ref.name === "main" && ref.remote === "origin@mirror"),
        ).toMatchObject({ tracked: false });
        await handler.handle(request);
        expect((await snapshot()).version).toBe(after.version);
      }
      await execCommand(
        "git",
        [
          "-c",
          "user.name=Test",
          "-c",
          "user.email=test@example.test",
          "-c",
          "commit.gpgsign=false",
          "commit",
          "--allow-empty",
          "-m",
          "Updated remote",
        ],
        { cwd: seed },
      );
      await execCommand("git", ["branch", "-f", "feature", "HEAD"], { cwd: seed });
      const updated = (
        await execCommand("git", ["rev-parse", "HEAD"], { cwd: seed })
      ).stdout.trim();
      const fetching = await snapshot();
      await handler.handle({
        kind: "execute",
        binding,
        version: fetching.version,
        operationId: "fetch-tracked",
        action: "fetch",
        input: { remote: "origin@mirror" },
      });
      await expect
        .poll(() => handler.handle({ kind: "operation", operationId: "fetch-tracked" }))
        .toMatchObject({ operation: { status: "succeeded" } });
      const fetched = await snapshot();
      expect(fetched.refs.find((ref) => ref.name === "feature" && !ref.remote)?.targets).toEqual([
        updated,
      ]);
      expect(
        fetched.refs.find((ref) => ref.name === "feature" && ref.remote === "other")?.targets,
      ).not.toEqual([updated]);
      const before = await snapshot();
      await handler.handle({
        kind: "execute",
        binding,
        version: before.version,
        operationId: "missing",
        action: "bookmark-track",
        input: { name: "missing", remote: "origin@mirror" },
      });
      await expect
        .poll(() => handler.handle({ kind: "operation", operationId: "missing" }))
        .toMatchObject({ operation: { status: "failed", error: { code: "outdated" } } });
      expect((await snapshot()).version).toBe(before.version);
    } finally {
      handler.dispose();
    }
  });

  it("splits and squashes whole files and manages bookmarks without an editor", async () => {
    const { execCommand } = await import("@getpaseo/plugin/server");
    const { createVcsHandler } = await import("@getpaseo/plugin/server/vcs");
    const { jjProvider } = await import("../../../../../plugins/jj-vcs/server/provider.js");
    const cwd = await mkdtemp(path.join(tmpdir(), "paseo-vcs-actions-"));
    temporaryDirectories.push(cwd);
    await execCommand("jj", ["git", "init", cwd]);
    await writeFile(path.join(cwd, "a | odd.txt"), "first\n");
    await writeFile(path.join(cwd, "b.txt"), "second\n");
    const handler = createVcsHandler(jjProvider);
    let operation = 0;
    const detected = await handler.handle({ kind: "detect", cwd });
    if (detected.kind !== "detect" || detected.detection.status !== "available")
      throw new Error(JSON.stringify(detected));
    const binding = detected.detection.binding;
    const snapshot = async () => {
      const result = await handler.handle({ kind: "snapshot", binding });
      if (result.kind !== "snapshot") throw new Error("Missing snapshot");
      return result.snapshot;
    };
    const perform = async (
      action: string,
      input: import("@getpaseo/protocol/agent-types").JsonValue,
    ) => {
      const state = await snapshot();
      const operationId = String(++operation);
      await handler.handle({
        kind: "execute",
        binding,
        operationId,
        version: state.version,
        action,
        input,
      });
      await expect
        .poll(() => handler.handle({ kind: "operation", operationId }))
        .toMatchObject({ operation: { status: "succeeded" } });
      return snapshot();
    };
    try {
      const initial = await snapshot();
      const split = await perform("split", {
        revision: initial.current!.id,
        files: ["a | odd.txt"],
        message: "Selected file",
      });
      expect(split.files.map((file) => file.path)).toEqual(["b.txt"]);
      const squashed = await perform("squash", {
        revision: split.current!.id,
        destination: split.current!.parents[0]!,
        files: ["b.txt"],
      });
      const rows = await handler.handle({ kind: "history", binding, limit: 10 });
      expect(rows).toMatchObject({
        kind: "history",
        revisions: expect.arrayContaining([
          expect.objectContaining({ description: "Selected file\n" }),
        ]),
      });
      await perform("bookmark-create", { name: "feature", revision: squashed.current!.id });
      expect((await snapshot()).refs.map((ref) => ref.name)).toContain("feature");
      await perform("bookmark-delete", { name: "feature" });
      expect((await snapshot()).refs).toEqual([]);
      const next = await perform("new", { parents: [squashed.current!.id] });
      expect(next.current!.parents).toEqual([squashed.current!.id]);
      await writeFile(path.join(cwd, "a | odd.txt"), "changed\n");
      const restored = await perform("restore", {
        revision: squashed.current!.id,
        files: ["a | odd.txt"],
      });
      expect(restored.files).toEqual([]);
      expect(await readFile(path.join(cwd, "a | odd.txt"), "utf8")).toBe("first\n");
    } finally {
      handler.dispose();
    }
  });

  it("uses the same neutral model for a real Git repository", async () => {
    const { execCommand } = await import("@getpaseo/plugin/server");
    const { createVcsHandler } = await import("@getpaseo/plugin/server/vcs");
    const { gitProvider } = await import("../../../../../plugins/git-vcs/server/provider.js");
    const cwd = await mkdtemp(path.join(tmpdir(), "paseo-vcs-git-"));
    temporaryDirectories.push(cwd);
    const git = (args: string[]) => execCommand("git", args, { cwd });
    await git(["init"]);
    await git(["config", "user.name", "VCS Test"]);
    await git(["config", "user.email", "vcs@example.test"]);
    await writeFile(path.join(cwd, "a.txt"), "original\n");
    await git(["add", "a.txt"]);
    await git(["commit", "-m", "Initial commit"]);
    const handler = createVcsHandler(gitProvider);
    try {
      const detection = await handler.handle({ kind: "detect", cwd });
      if (detection.kind !== "detect" || detection.detection.status !== "available")
        throw new Error(JSON.stringify(detection));
      const binding = detection.detection.binding;
      await writeFile(path.join(cwd, "a.txt"), "changed\n");
      expect(await handler.handle({ kind: "snapshot", binding })).toMatchObject({
        snapshot: { files: [{ path: "a.txt", status: " M", conflict: false }] },
      });
      const diff = await handler.handle({
        kind: "diff",
        binding,
        comparison: { kind: "working-copy" },
      });
      expect(diff.kind === "diff" && diff.patch).toContain("+changed");
      expect(await handler.handle({ kind: "history", binding, limit: 5 })).toMatchObject({
        revisions: [{ description: "Initial commit\n" }],
      });
    } finally {
      handler.dispose();
    }
  });
});

describe("Git VCS shared actions", () => {
  it("builds base comparisons from frozen snapshots without changing the real index", async () => {
    const { execCommand } = await import("@getpaseo/plugin/server");
    const { createVcsHandler } = await import("@getpaseo/plugin/server/vcs");
    const { gitProvider } = await import("../../../../../plugins/git-vcs/server/provider.js");
    const cwd = await mkdtemp(path.join(tmpdir(), "paseo-git-base-"));
    temporaryDirectories.push(cwd);
    const git = (args: string[]) =>
      execCommand("git", ["-c", "commit.gpgsign=false", ...args], { cwd });
    await git(["init", "-b", "main"]);
    await git(["config", "user.name", "VCS Test"]);
    await git(["config", "user.email", "vcs@example.test"]);
    await writeFile(path.join(cwd, "cancel.txt"), "base\n");
    await writeFile(path.join(cwd, "space.txt"), "one two\n");
    await git(["add", "."]);
    await git(["commit", "-m", "Base"]);
    const base = (await git(["rev-parse", "HEAD"])).stdout.trim();
    await git(["switch", "-c", "feature"]);
    await writeFile(path.join(cwd, "cancel.txt"), "committed\n");
    await writeFile(path.join(cwd, "committed.txt"), "keep\n");
    await git(["add", "."]);
    await git(["commit", "-m", "Feature"]);
    await writeFile(path.join(cwd, "cancel.txt"), "base\n");
    await writeFile(path.join(cwd, "space.txt"), "one   two\n");
    await writeFile(path.join(cwd, "binary.bin"), Buffer.from([0, 1, 2]));
    await git(["add", "space.txt"]);
    const handler = createVcsHandler(gitProvider);
    try {
      const detection = await handler.handle({ kind: "detect", cwd });
      if (detection.kind !== "detect" || detection.detection.status !== "available")
        throw new Error(JSON.stringify(detection));
      const binding = detection.detection.binding;
      const response = await handler.handle({ kind: "snapshot", binding });
      if (response.kind !== "snapshot") throw new Error(JSON.stringify(response));
      const version = response.snapshot.version;
      const index = await readFile(path.join(cwd, ".git/index"));
      const diff = async (mode: string, ignoreWhitespace = false) => {
        const result = await handler.handle({
          kind: "diff",
          binding,
          comparison: {
            kind: "working-copy",
            data: { version: 2, data: { version, mode, base, ignoreWhitespace } },
          },
        });
        if (result.kind !== "diff") throw new Error(JSON.stringify(result));
        return result.patch;
      };
      const { resolveGitComparison } =
        await import("../../../../../plugins/git-vcs/client/comparison.js");
      const pinned = resolveGitComparison({
        snapshot: response.snapshot,
        id: "committed",
        baseRef: base,
        ignoreWhitespace: false,
      });
      if (!pinned.comparison) throw new Error(pinned.error);
      const pinnedDiff = await handler.handle({
        kind: "diff",
        binding,
        comparison: pinned.comparison,
      });
      expect(pinnedDiff).toMatchObject({
        kind: "diff",
        patch: expect.stringContaining("+committed"),
      });
      const combined = await diff("combined");
      expect(combined).not.toContain("cancel.txt");
      expect(combined).toContain("+keep");
      expect(combined).toContain("GIT binary patch");
      expect(combined).toContain("+one   two");
      expect(await diff("committed")).toContain("+committed");
      expect(await diff("all")).toContain("+base");
      expect(await diff("staged", true)).toBe("");
      expect(await diff("unstaged", true)).toContain("+base");
      expect(await diff("combined", true)).not.toContain("space.txt");
      await writeFile(path.join(cwd, "cancel.txt"), "later\n");
      await git(["branch", "-f", "main", "HEAD"]);
      expect(await diff("combined")).toBe(combined);
      expect(await readFile(path.join(cwd, ".git/index"))).toEqual(index);
      expect(await readFile(path.join(cwd, "cancel.txt"), "utf8")).toBe("later\n");
    } finally {
      handler.dispose();
    }
  });

  it("keeps staged and unstaged patches pinned, validates literal paths, and commits only the index", async () => {
    const { execCommand } = await import("@getpaseo/plugin/server");
    const { createVcsHandler } = await import("@getpaseo/plugin/server/vcs");
    const { gitProvider } = await import("../../../../../plugins/git-vcs/server/provider.js");
    const cwd = await mkdtemp(path.join(tmpdir(), "paseo-git-actions-"));
    temporaryDirectories.push(cwd);
    const git = (args: string[]) =>
      execCommand("git", ["-c", "commit.gpgsign=false", ...args], { cwd });
    await git(["init", "-b", "main"]);
    await git(["config", "user.name", "VCS Test"]);
    await git(["config", "user.email", "vcs@example.test"]);
    await git(["config", "commit.gpgsign", "false"]);
    const handler = createVcsHandler(gitProvider);
    const detection = await handler.handle({ kind: "detect", cwd });
    if (detection.kind !== "detect" || detection.detection.status !== "available")
      throw new Error(JSON.stringify(detection));
    const binding = detection.detection.binding;
    const snapshot = async () => {
      const response = await handler.handle({ kind: "snapshot", binding });
      if (response.kind !== "snapshot") throw new Error(JSON.stringify(response));
      return response.snapshot;
    };
    const execute = async (
      action: string,
      input: import("@getpaseo/plugin").JsonValue,
      version: string,
      id = randomUUID(),
    ) => {
      let response = await handler.handle({
        kind: "execute",
        binding,
        operationId: id,
        version,
        action,
        input,
      });
      await vi.waitFor(async () => {
        response = await handler.handle({ kind: "operation", operationId: id });
        expect(response.kind === "operation" && response.operation.status).not.toMatch(
          /pending|running/,
        );
      });
      return response;
    };
    try {
      await writeFile(path.join(cwd, "a.txt"), "original\n");
      const unborn = await snapshot();
      expect(
        await handler.handle({ kind: "history", binding, limit: 10, version: unborn.version }),
      ).toMatchObject({ revisions: [] });
      expect(
        await handler.handle({ kind: "diff", binding, comparison: unborn.workingComparison! }),
      ).toMatchObject({ patch: expect.stringContaining("+original") });
      expect(await execute("stage", { files: ["a.txt"] }, unborn.version)).toMatchObject({
        operation: { status: "succeeded" },
      });
      const staged = await snapshot();
      await writeFile(path.join(cwd, "a.txt"), "unstaged edit\n");
      const current = await snapshot();
      expect(
        await handler.handle({ kind: "diff", binding, comparison: staged.workingComparison! }),
      ).toMatchObject({ patch: expect.stringContaining("+original") });
      expect(
        await handler.handle({
          kind: "diff",
          binding,
          comparison: current.comparisons!.find((item) => item.id === "staged")!.comparison,
        }),
      ).toMatchObject({ patch: expect.stringContaining("+original") });
      expect(
        await handler.handle({
          kind: "diff",
          binding,
          comparison: current.comparisons!.find((item) => item.id === "unstaged")!.comparison,
        }),
      ).toMatchObject({ patch: expect.stringContaining("+unstaged edit") });
      expect(
        await execute("commit", { message: "stale", all: false }, staged.version),
      ).toMatchObject({ operation: { status: "failed", error: { code: "outdated" } } });
      const id = randomUUID();
      expect(
        await execute("commit", { message: "First", all: false }, current.version, id),
      ).toMatchObject({ operation: { status: "succeeded" } });
      expect((await git(["show", "HEAD:a.txt"])).stdout).toBe("original\n");
      expect(await readFile(path.join(cwd, "a.txt"), "utf8")).toBe("unstaged edit\n");
      expect(
        await execute("commit", { message: "First", all: false }, current.version, id),
      ).toMatchObject({ operation: { status: "succeeded" } });
      expect((await git(["rev-list", "--count", "HEAD"])).stdout.trim()).toBe("1");
      const committed = await snapshot();
      expect(
        await handler.handle({
          kind: "diff",
          binding,
          comparison: { kind: "revision", revision: committed.current!.id },
        }),
      ).toMatchObject({ patch: expect.stringContaining("+original") });
      expect(await execute("stage", { files: [":(glob)*"] }, committed.version)).toMatchObject({
        operation: { status: "failed" },
      });
      expect(await execute("discard", { files: ["../outside"] }, committed.version)).toMatchObject({
        operation: { status: "failed" },
      });
      expect(await execute("discard", { files: ["a.txt"] }, committed.version)).toMatchObject({
        operation: { status: "succeeded" },
      });
      expect(await readFile(path.join(cwd, "a.txt"), "utf8")).toBe("original\n");
      await writeFile(path.join(cwd, "added.txt"), "new file\n");
      expect(
        await execute("stage", { files: ["added.txt"] }, (await snapshot()).version),
      ).toMatchObject({
        operation: { status: "succeeded" },
      });
      expect(
        await execute("unstage", { files: ["added.txt"] }, (await snapshot()).version),
      ).toMatchObject({
        operation: { status: "succeeded" },
      });
      expect((await git(["diff", "--cached", "--name-only"])).stdout).toBe("");
      expect(await readFile(path.join(cwd, "added.txt"), "utf8")).toBe("new file\n");
      await execute("stage", { files: ["added.txt"] }, (await snapshot()).version);
      expect(
        await execute("discard", { files: ["added.txt"] }, (await snapshot()).version),
      ).toMatchObject({
        operation: { status: "succeeded" },
      });
      await expect(readFile(path.join(cwd, "added.txt"))).rejects.toMatchObject({ code: "ENOENT" });
      const clean = await snapshot();
      expect(
        await execute(
          "branch-create",
          { name: "feature", revision: clean.current!.id },
          clean.version,
        ),
      ).toMatchObject({ operation: { status: "succeeded" } });
      expect((await git(["branch", "--show-current"])).stdout.trim()).toBe("feature");
      const branch = await snapshot();
      expect(await execute("branch-switch", { name: "main" }, branch.version)).toMatchObject({
        operation: { status: "succeeded" },
      });
    } finally {
      handler.dispose();
    }
  });
});

describe("VCS operation cancellation", () => {
  it("cancels queued work without executing it and preserves an unknown running outcome", async () => {
    const { createVcsHandler } = await import("@getpaseo/plugin/server/vcs");
    const binding = {
      providerId: "fixture",
      repositoryId: "repo",
      workingCopyId: "copy",
      root: "/repo",
      cwd: "/repo",
    };
    const calls: string[] = [];
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const handler = createVcsHandler({
      id: "fixture",
      label: "Fixture",
      async detect() {
        return { status: "available", binding };
      },
      async snapshot() {
        return {
          binding,
          version: "1",
          current: null,
          files: [],
          refs: [],
          capabilities: ["actions"],
          state: "ready",
          actions: [{ id: "wait", enabled: true }],
        };
      },
      async history() {
        return { revisions: [] };
      },
      async diff() {
        return "";
      },
      async execute(_binding, _action, _input, { signal }) {
        calls.push("executed");
        markStarted();
        return new Promise<never>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("Cancelled")), { once: true });
        });
      },
    });
    const request = { kind: "execute" as const, binding, version: "1", action: "wait", input: {} };
    try {
      await handler.handle({ ...request, operationId: "running" });
      await started;
      await handler.handle({ ...request, operationId: "queued" });
      await handler.handle({ kind: "cancel", operationId: "queued" });
      await handler.handle({ kind: "cancel", operationId: "running" });
      await expect
        .poll(() => handler.handle({ kind: "operation", operationId: "running" }))
        .toMatchObject({ operation: { status: "unknown", error: { code: "cancelled" } } });
      await expect
        .poll(() => handler.handle({ kind: "operation", operationId: "queued" }))
        .toMatchObject({ operation: { status: "failed", error: { code: "cancelled" } } });
      expect(calls).toEqual(["executed"]);
      await handler.handle({ ...request, operationId: "running" });
      expect(calls).toEqual(["executed"]);
    } finally {
      handler.dispose();
    }
  });
});

describe("VCS local files", () => {
  it.each(["git", "jj-colocated", "jj-separate"])(
    "selects ignored files using the tracking model of %s without snapshotting",
    async (mode) => {
      const { execCommand } = await import("@getpaseo/plugin/server");
      const { createVcsHandler } = await import("@getpaseo/plugin/server/vcs");
      const { jjProvider } = await import("../../../../../plugins/jj-vcs/server/provider.js");
      const { gitProvider } = await import("../../../../../plugins/git-vcs/server/provider.js");
      const root = await mkdtemp(path.join(tmpdir(), "paseo-vcs-local-files-"));
      temporaryDirectories.push(root);
      const repository = path.join(root, "repository");
      await execCommand("git", ["init", repository]);
      const git = (args: string[]) => execCommand("git", args, { cwd: repository });
      await writeFile(
        path.join(repository, ".gitignore"),
        "*.env\nconfig/*.local\ntracked.ignored\n",
      );
      await writeFile(path.join(repository, "tracked.ignored"), "tracked");
      await git(["add", ".gitignore"]);
      await git(["add", "-f", "tracked.ignored"]);
      await git([
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.test",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "-m",
        "initial",
      ]);
      let cwd = repository;
      if (mode !== "git") await execCommand("jj", ["git", "init", "--colocate", repository]);
      if (mode === "jj-separate") {
        cwd = path.join(root, "separate");
        await execCommand("jj", ["workspace", "add", "--no-colocate", cwd], { cwd: repository });
      }
      await mkdir(path.join(cwd, "config"));
      await writeFile(path.join(cwd, "config", "app.local"), "local");
      await writeFile(path.join(cwd, "config", "skip.local"), "skip");
      await writeFile(path.join(cwd, "odd\n.env"), "newline filename");
      await writeFile(path.join(cwd, "plain.txt"), "not ignored and not tracked");
      // A colocated Git index is not the jj tracking model, including after external staging.
      if (mode !== "git")
        await execCommand("git", [
          "--git-dir",
          path.join(repository, ".git"),
          "--work-tree",
          cwd,
          "add",
          "-f",
          "odd\n.env",
        ]);
      const provider = mode === "git" ? gitProvider : jjProvider;
      const handler = createVcsHandler(provider);
      try {
        const detection = await handler.handle({ kind: "detect", cwd });
        if (detection.kind !== "detect" || detection.detection.status !== "available")
          throw new Error("Missing binding");
        const binding = detection.detection.binding;
        const indexBefore = await readFile(path.join(repository, ".git", "index"));
        const before =
          mode === "git"
            ? "git"
            : (
                await execCommand(
                  "jj",
                  ["--ignore-working-copy", "op", "log", "-n", "1", "--no-graph", "-T", "id"],
                  { cwd },
                )
              ).stdout;
        expect(
          await handler.handle({
            kind: "local-files",
            binding,
            query: {
              kind: "ignored",
              patterns: [
                "*.env",
                "config/*.local",
                "tracked.ignored",
                "plain.txt",
                "!config/skip.local",
              ],
            },
          }),
        ).toEqual({ kind: "local-files", paths: ["config/app.local", "odd\n.env"] });
        expect(
          await handler.handle({ kind: "local-files", binding, query: { kind: "tracked" } }),
        ).toEqual({ kind: "local-files", paths: [".gitignore", "tracked.ignored"] });
        expect(
          await handler.handle({
            kind: "local-files",
            binding,
            query: { kind: "ignored", patterns: ["*"] },
          }),
        ).toEqual({
          kind: "local-files",
          paths: ["config/app.local", "config/skip.local", "odd\n.env"],
        });
        const after =
          mode === "git"
            ? "git"
            : (
                await execCommand(
                  "jj",
                  ["--ignore-working-copy", "op", "log", "-n", "1", "--no-graph", "-T", "id"],
                  { cwd },
                )
              ).stdout;

        expect(after).toBe(before);
        expect(await readFile(path.join(repository, ".git", "index"))).toEqual(indexBefore);
      } finally {
        handler.dispose();
      }
    },
  );
});

describe("VCS include copying", () => {
  it("preserves existing and tracked destinations, copies selected file links, and rejects a linked destination directory", async () => {
    const { execCommand } = await import("@getpaseo/plugin/server");
    const { gitProvider } = await import("../../../../../plugins/git-vcs/server/provider.js");
    const { copyWorktreeIncludes } =
      await import("../../../../../plugins/worktree-include/server/copy.js");
    const root = await mkdtemp(path.join(tmpdir(), "paseo-copy-local-files-"));
    temporaryDirectories.push(root);
    const source = path.join(root, "source");
    const target = path.join(root, "target");
    const outside = path.join(root, "outside");
    await mkdir(outside);
    for (const cwd of [source, target]) {
      await execCommand("git", ["init", cwd]);
      await writeFile(path.join(cwd, ".gitignore"), "*.env\n");
    }
    await writeFile(path.join(source, ".worktreeinclude"), "*.env\n");
    await writeFile(path.join(source, "existing.env"), "source version");
    await writeFile(path.join(target, "existing.env"), "keep destination");
    await writeFile(path.join(source, "tracked.env"), "must not copy");
    await writeFile(path.join(target, "tracked.env"), "tracked");
    await execCommand("git", ["add", "-f", "tracked.env"], { cwd: target });
    await rm(path.join(target, "tracked.env"));
    await writeFile(path.join(outside, "external.env"), "outside");
    await symlink(path.join(outside, "external.env"), path.join(source, "link.env"));
    const context = { signal: new AbortController().signal };
    const detectedSource = await gitProvider.detect(source, context);
    const detectedTarget = await gitProvider.detect(target, context);
    if (detectedSource.status !== "available" || detectedTarget.status !== "available")
      throw new Error("Expected repositories");
    const listLocalFiles = gitProvider.localFiles;
    if (!listLocalFiles) throw new Error("Expected local file queries");
    const options = {
      source: detectedSource.binding,
      target: detectedTarget.binding,
      signal: context.signal,
      vcs: {
        listLocalFiles: (
          binding: import("@getpaseo/plugin").VcsBinding,
          query: import("@getpaseo/plugin").VcsLocalFilesQuery,
        ) => listLocalFiles(binding, query, context),
      },
    };
    expect(await copyWorktreeIncludes(options)).toEqual({
      kind: "copied",
      copied: ["link.env"],
      skipped: ["existing.env", "tracked.env"],
    });
    expect(await readFile(path.join(target, "existing.env"), "utf8")).toBe("keep destination");
    await expect(readFile(path.join(target, "tracked.env"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await readFile(path.join(target, "link.env"), "utf8")).toBe("outside");
    await mkdir(path.join(source, "config"));
    await writeFile(path.join(source, "config", "app.env"), "local");
    await symlink(outside, path.join(target, "config"));
    await expect(copyWorktreeIncludes(options)).rejects.toThrow(
      "Local file destination is not a directory",
    );
    await expect(readFile(path.join(outside, "app.env"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("VCS ignored file availability", () => {
  it("reports an unavailable Git matcher when Git is missing", async () => {
    const { listGitIgnoredFiles } = await import("@getpaseo/plugin/server/vcs");
    const cwd = await mkdtemp(path.join(tmpdir(), "paseo-missing-git-"));
    temporaryDirectories.push(cwd);
    const previousPath = process.env.PATH;
    process.env.PATH = cwd;
    try {
      await expect(
        listGitIgnoredFiles({ cwd, patterns: [".env"], signal: new AbortController().signal }),
      ).rejects.toMatchObject({
        problem: {
          code: "unavailable",
          message: "Git executable is required to select ignored local files",
        },
      });
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  });
});

describe("VCS working-copy recovery", () => {
  it.each(["git", "jj"])(
    "preserves exact tracked state and releases durable references for %s",
    async (providerId) => {
      const { execCommand } = await import("@getpaseo/plugin/server");
      const { createVcsHandler } = await import("@getpaseo/plugin/server/vcs");
      const { VcsWorkingCopyRecordSchema } = await import("@getpaseo/plugin");
      const { gitProvider } = await import("../../../../../plugins/git-vcs/server/provider.js");
      const { jjProvider } = await import("../../../../../plugins/jj-vcs/server/provider.js");
      const root = await mkdtemp(path.join(tmpdir(), "paseo-vcs-recovery-"));
      temporaryDirectories.push(root);
      const cwd = path.join(root, "repo");
      const target = path.join(root, "copy");
      await execCommand("git", ["init", cwd]);
      await mkdir(path.join(cwd, "sub"));
      await writeFile(path.join(cwd, "sub", "a.txt"), "initial\n");
      await execCommand("git", ["add", "."], { cwd });
      await execCommand(
        "git",
        [
          "-c",
          "user.name=Test",
          "-c",
          "user.email=test@example.test",
          "-c",
          "commit.gpgsign=false",
          "commit",
          "-m",
          "initial",
        ],
        { cwd },
      );
      if (providerId === "jj") await execCommand("jj", ["git", "init", "--colocate", cwd]);
      const handler = createVcsHandler(providerId === "git" ? gitProvider : jjProvider);
      async function completed(
        request: import("@getpaseo/plugin").VcsRequest & { operationId: string },
      ) {
        await Promise.all([handler.handle(request), handler.handle(request)]);
        await expect
          .poll(async () => {
            const response = await handler.handle({
              kind: "operation",
              operationId: request.operationId,
            });
            if (response.kind !== "operation") throw new Error("Missing operation");
            if (response.operation.status === "failed")
              throw new Error(JSON.stringify(response.operation.error));
            return response.operation.status;
          })
          .toBe("succeeded");
        const response = await handler.handle({
          kind: "operation",
          operationId: request.operationId,
        });
        if (response.kind !== "operation") throw new Error("Missing result");
        return VcsWorkingCopyRecordSchema.parse(response.operation.result);
      }
      try {
        const detection = await handler.handle({ kind: "detect", cwd });
        if (detection.kind !== "detect" || detection.detection.status !== "available")
          throw new Error("Missing repository");
        const binding = detection.detection.binding;
        const snapshot = await handler.handle({ kind: "snapshot", binding });
        if (snapshot.kind !== "snapshot" || !snapshot.snapshot.current)
          throw new Error("Missing revision");
        let record = await completed({
          kind: "execute",
          operationId: "create-copy",
          binding,
          action: "working-copy.create",
          version: snapshot.snapshot.version,
          input: { root: target, name: "task", revision: snapshot.snapshot.current.id },
        });
        await writeFile(path.join(target, "sub", "a.txt"), "staged\n");
        if (providerId === "git") await execCommand("git", ["add", "."], { cwd: target });
        await writeFile(path.join(target, "sub", "a.txt"), "working\n");
        record = await completed({
          kind: "working-copy.recovery",
          operation: "prepare-removal",
          record,
          operationId: "prepare",
        });
        expect(record.recovery?.version).toBe(1);
        const previous = record;
        await writeFile(path.join(target, "sub", "a.txt"), "late external edit\n");
        await handler.handle({
          kind: "working-copy.recovery",
          operation: "remove",
          record,
          operationId: "stale-remove",
        });
        await expect
          .poll(() => handler.handle({ kind: "operation", operationId: "stale-remove" }))
          .toMatchObject({ operation: { status: "failed", error: { code: "outdated" } } });
        expect(await readFile(path.join(target, "sub", "a.txt"), "utf8")).toBe(
          "late external edit\n",
        );
        await writeFile(path.join(target, "sub", "a.txt"), "working\n");
        record = await completed({
          kind: "working-copy.recovery",
          operation: "prepare-removal",
          record,
          operationId: "prepare-fresh",
        });
        await completed({
          kind: "working-copy.recovery",
          operation: "release",
          record: previous,
          operationId: "release-old",
        });
        const prepared = record;
        record = await completed({
          kind: "working-copy.recovery",
          operation: "remove",
          record,
          operationId: "remove",
        });
        await expect(readFile(path.join(target, "sub", "a.txt"))).rejects.toMatchObject({
          code: "ENOENT",
        });
        expect(
          await handler.handle({
            kind: "working-copy.recovery",
            operation: "remove",
            record: prepared,
            operationId: "remove",
          }),
        ).toMatchObject({ operation: { status: "succeeded" } });
        expect(await handler.handle({ kind: "working-copy.inspect", record })).toEqual({
          kind: "working-copy.inspect",
        });
        if (providerId === "jj") {
          const { z } = await import("zod");
          const data = z.object({ revision: z.string() }).parse(record.recovery?.data);
          await execCommand("jj", ["abandon", data.revision], { cwd });
          await execCommand("jj", ["op", "abandon", "..@-"], { cwd });
          await execCommand("jj", ["util", "gc", "--expire", "now"], { cwd });
          const backend = (
            await execCommand("jj", ["--ignore-working-copy", "git", "root"], { cwd })
          ).stdout.trim();
          await execCommand("git", ["--git-dir", backend, "gc", "--prune=now"], { cwd });
          await execCommand("jj", ["workspace", "update-stale"], { cwd });
        }
        record = await completed({
          kind: "working-copy.recovery",
          operation: "restore",
          record,
          operationId: "restore",
        });
        expect(await readFile(path.join(target, "sub", "a.txt"), "utf8")).toBe("working\n");
        if (providerId === "git")
          expect((await execCommand("git", ["show", ":sub/a.txt"], { cwd: target })).stdout).toBe(
            "staged\n",
          );
        const released = await completed({
          kind: "working-copy.recovery",
          operation: "release",
          record,
          operationId: "release",
        });
        expect(released.recovery).toBeUndefined();
        const refs = await execCommand("git", ["for-each-ref"], { cwd });
        expect(refs.stdout).not.toContain("paseo-recovery-");
        expect(refs.stdout).not.toContain("refs/paseo/recovery/");
      } finally {
        handler.dispose();
      }
    },
  );
});

describe("jj publication auto-archive", () => {
  afterEach(() => vi.unstubAllEnvs());
  it.each([
    "published",
    "empty-child",
    "modified",
    "described-child",
    "conflict",
    "stale",
    "foreign",
    "shared",
    "race",
    "first-merged",
  ])(
    "preserves work and recovery through the archive pipeline: %s",
    async (scenario) => {
      const { execCommand } = await import("@getpaseo/plugin/server");
      const { createVcsHandler } = await import("@getpaseo/plugin/server/vcs");
      const { jjProvider } = await import("../../../../../plugins/jj-vcs/server/provider.js");
      const { WorkspaceVcsService } = await import("../workspace-vcs-service.js");
      const { setupAutoArchiveOnMerge } = await import("../auto-archive-on-merge/index.js");
      const {
        createPersistedProjectRecord,
        createPersistedWorkspaceRecord,
        FileBackedProjectRegistry,
        FileBackedWorkspaceRegistry,
      } = await import("../workspace-registry.js");
      const { createForgeResolver } = await import("../../services/forge-resolver.js");
      const { createGitHubService } = await import("../../services/github-service.js");
      const root = await mkdtemp(path.join(tmpdir(), "jj-archive-publication-"));
      temporaryDirectories.push(root);
      vi.stubEnv("XDG_CONFIG_HOME", path.join(root, "config"));
      const source = path.join(root, "source");
      const cwd = path.join(root, "copy");
      const remote = path.join(root, "remote.git");
      const jj = async (args: string[], directory = cwd) =>
        (await execCommand("jj", args, { cwd: directory })).stdout.trim();
      await execCommand("jj", ["git", "init", source]);
      await jj(["config", "set", "--repo", "user.name", "Archive Test"], source);
      await jj(["config", "set", "--repo", "user.email", "archive@example.test"], source);
      await writeFile(path.join(source, "file.txt"), "published\n");
      await jj(["describe", "-m", "Published work"], source);
      const context = { signal: new AbortController().signal };
      const detected = await jjProvider.detect(source, context);
      if (detected.status !== "available") throw new Error("Missing jj repository");
      const snapshot = await jjProvider.snapshot(detected.binding, context);
      const record = await jjProvider.workingCopies!.create(
        detected.binding,
        {
          root: cwd,
          name: "review",
          revision: snapshot.current!.id,
        },
        { ...context, snapshot },
      );
      await jj(["edit", snapshot.current!.id]);
      await jj(["bookmark", "create", "topic", "-r", "@"]);
      await execCommand("git", ["init", "--bare", remote]);
      await jj(["git", "remote", "add", "origin", remote]);
      await jj(["git", "push", "--remote", "origin", "--bookmark", "topic"]);
      const handler = createVcsHandler(jjProvider);
      const log = pino({ level: "silent" });
      const projects = new FileBackedProjectRegistry(path.join(root, "projects.json"), log);
      const workspaces = new FileBackedWorkspaceRegistry(path.join(root, "workspaces.json"), log);
      await projects.initialize();
      await workspaces.initialize();
      const now = new Date().toISOString();
      await projects.upsert(
        createPersistedProjectRecord({
          projectId: "p",
          rootPath: source,
          kind: "git",
          displayName: "Archive",
          vcsProviderId: "jj",
          createdAt: now,
          updatedAt: now,
        }),
      );
      const workspace = {
        ...createPersistedWorkspaceRecord({
          projectId: "p",
          workspaceId: "w",
          cwd,
          kind: "directory",
          displayName: "Review",
          createdAt: now,
          updatedAt: now,
        }),
        vcsWorkingCopy: { ...record, owned: scenario !== "foreign" },
      };
      await workspaces.upsert(workspace);
      if (scenario === "shared") await workspaces.upsert({ ...workspace, workspaceId: "sibling" });
      const targetResponse = await handler.handle({
        kind: "publication.resolve",
        binding: record.binding,
        selection: { remote: "origin", headRef: "topic", baseRef: "main" },
      });
      if (targetResponse.kind !== "publication") throw new Error("Missing target");
      const target = targetResponse.publication;
      let status: import("../../services/forge-service.js").CurrentPullRequestStatus = {
        number: 7,
        url: "https://forge.test/repo/pull/7",
        title: "Review",
        state: "open",
        baseRefName: "main",
        headRefName: "topic",
        isMerged: false,
        mergeable: "MERGEABLE",
        checks: [],
        checksStatus: "none",
        reviewDecision: null,
      };
      const forge = {
        ...createForgeResolver(),
        async resolveRepository() {
          return {
            forge: "fixture",
            host: "forge.test",
            service: {
              ...createGitHubService(),
              invalidate() {},
              async getCurrentPullRequestStatus(input: { reason?: string }) {
                if (scenario === "race" && input.reason === "vcs-auto-archive-validation")
                  await writeFile(path.join(cwd, "file.txt"), "racing edit\n");
                return status;
              },
            },
          };
        },
      };
      const plugins = {
        listVcsProviders: () => [{ id: "jj", label: "jj", pluginId: "jj-vcs" }],
        invokeVcs: async (_id: string, request: import("@getpaseo/plugin").VcsRequest) =>
          handler.handle(request),
      };
      const vcs = new WorkspaceVcsService({ projects, workspaces, plugins, forge });
      let archiveAttempts = 0;
      let archiveCompletions = 0;
      let finishArchive!: () => void;
      const archived = new Promise<void>((resolve) => {
        finishArchive = resolve;
      });
      const options = {
        logger: log,
        vcs,
        paseoHome: root,
        daemonConfigStore: { get: () => ({ autoArchiveAfterMerge: true }) },
        workspaceGitService: {
          onSnapshotUpdated: () => ({ unsubscribe() {} }),
          invalidateWorktrees() {},
        },
        github: createGitHubService(),
        agentManager: { listAgents: () => [] },
        agentStorage: { listByWorkspace: async () => [] },
        terminalManager: null,
        findWorkspaceIdForCwd: async () => "w",
        listActiveWorkspaces: async () =>
          (await workspaces.list()).filter((entry) => !entry.archivedAt),
        getAutoArchivedChangeRequestUrl: async (id: string) =>
          (await workspaces.get(id))?.autoArchivedChangeRequestUrl ?? null,
        archiveWorkspaceRecord: async (
          id: string,
          archiveContext: import("../workspace-registry.js").WorkspaceArchiveContext,
        ) => {
          archiveAttempts++;
          await workspaces.archive(id, new Date().toISOString(), archiveContext);
        },
        markWorkspaceArchiving() {},
        clearWorkspaceArchiving() {},
        emitWorkspaceUpdatesForWorkspaceIds: async () => {},
      } as unknown as import("../auto-archive-on-merge/index.js").AutoArchiveOnMergeOptions;
      const { archivePublicationIfSafe } =
        await import("../auto-archive-on-merge/archive-if-safe.js");
      const subscription = setupAutoArchiveOnMerge(options, {
        resolvePath: path.resolve,
        archiveIfSafe: async () => {},
        archivePublicationIfSafe: async (input) => {
          try {
            await archivePublicationIfSafe(input);
          } finally {
            archiveCompletions++;
            finishArchive();
          }
        },
      });
      try {
        if (scenario !== "first-merged") await vcs.publication.status("w", record.binding, target);
        async function changeAfterPublication() {
          if (scenario === "empty-child" || scenario === "described-child") {
            await jj(["new"]);
            if (scenario === "described-child") await jj(["describe", "-m", "Next task"]);
          }
          if (scenario === "modified") await writeFile(path.join(cwd, "file.txt"), "unpublished\n");
          if (scenario === "conflict") {
            await jj(["new", target.headRevision]);
            await writeFile(path.join(cwd, "file.txt"), "left\n");
            const left = await jj(["log", "--no-graph", "-r", "@", "-T", "commit_id"]);
            await jj(["new", target.headRevision]);
            await writeFile(path.join(cwd, "file.txt"), "right\n");
            await jj(["new", left, "@"]);
            expect((await jjProvider.snapshot(record.binding, context)).current?.conflict).toBe(
              true,
            );
          }
          if (scenario === "stale") {
            const checkout = await readFile(path.join(cwd, ".jj/working_copy/checkout"));
            await jj(["new", target.headRevision], source);
            await writeFile(path.join(source, "file.txt"), "external rewrite\n");
            await jj(
              ["restore", "--from", "@", "--into", target.headRevision, "--", "file.txt"],
              source,
            );
            expect((await jjProvider.snapshot(record.binding, context)).state).toBe("stale");
            expect(await readFile(path.join(cwd, ".jj/working_copy/checkout"))).toEqual(checkout);
          }
        }
        await changeAfterPublication();
        status = { ...status, state: "merged", isMerged: true };
        if (["modified", "stale"].includes(scenario)) {
          await expect(vcs.publication.status("w", record.binding, target)).rejects.toThrow();
          const archive = () =>
            archivePublicationIfSafe({
              event: {
                workspaceId: "w",
                binding: record.binding,
                target,
                forge: "fixture",
                status,
              },
              options,
              log,
            });
          if (scenario === "stale")
            await expect(archive()).rejects.toMatchObject({ problem: { code: "stale" } });
          else await archive();
        } else {
          await vcs.publication.status("w", record.binding, target);
          if (scenario === "first-merged")
            await new Promise<void>((resolve) => setImmediate(resolve));
          else await archived;
        }
        async function expectRetainedCopy() {
          expect(await readdir(cwd)).toContain("file.txt");
          if (scenario === "shared")
            expect((await workspaces.get("sibling"))?.archivedAt).toBeNull();
          if (scenario === "race")
            expect(await readFile(path.join(cwd, "file.txt"), "utf8")).toBe("racing edit\n");
          if (scenario === "modified")
            expect(await readFile(path.join(cwd, "file.txt"), "utf8")).toBe("unpublished\n");
        }
        const shouldArchive = ["published", "empty-child", "shared"].includes(scenario);
        expect(Boolean((await workspaces.get("w"))?.archivedAt)).toBe(shouldArchive);
        expect(archiveAttempts).toBe(shouldArchive ? 1 : 0);
        if (shouldArchive && scenario !== "shared") {
          await expect(readdir(cwd)).rejects.toMatchObject({ code: "ENOENT" });
          expect((await workspaces.get("w"))?.vcsWorkingCopy?.recovery?.version).toBe(1);
          const gitDirectory = await jj(["--ignore-working-copy", "git", "root"], source);
          const anchors = async () =>
            (
              await execCommand("git", [
                "--git-dir",
                gitDirectory,
                "for-each-ref",
                "--format=%(refname)",
                "refs/paseo/recovery",
              ])
            ).stdout.trim();
          expect((await anchors()).split("\n")).toHaveLength(1);
          expect(await anchors()).toMatch(/^refs\/paseo\/recovery\/[a-f0-9]{64}$/);
          await vcs.restoreWorkingCopy("w");
          expect(await readFile(path.join(cwd, "file.txt"), "utf8")).toBe("published\n");
          await workspaces.update("w", (current) => ({ ...current, archivedAt: null }));
          await vcs.finishWorkingCopyRestore("w");
          expect(await anchors()).toBe("");
          expect((await workspaces.get("w"))?.vcsWorkingCopy?.recovery).toBeUndefined();
          await vcs.publication.status("w", record.binding, target);
          await expect.poll(() => archiveCompletions).toBe(2);
          expect(archiveAttempts).toBe(1);
        } else await expectRetainedCopy();
      } finally {
        subscription.unsubscribe();
        handler.dispose();
      }
    },
    30_000,
  );
});

describe("VCS publication", () => {
  afterEach(() => vi.unstubAllEnvs());
  it.each(["git", "jj"])("publishes only the selected exact revision for %s", async (id) => {
    const { execCommand } = await import("@getpaseo/plugin/server");
    const { createVcsHandler } = await import("@getpaseo/plugin/server/vcs");
    const { gitProvider } = await import("../../../../../plugins/git-vcs/server/provider.js");
    const { jjProvider } = await import("../../../../../plugins/jj-vcs/server/provider.js");
    const root = await mkdtemp(path.join(tmpdir(), "paseo-publication-"));
    temporaryDirectories.push(root);
    vi.stubEnv("XDG_CONFIG_HOME", path.join(root, "config"));
    const seed = path.join(root, "seed");
    const remote = path.join(root, "remote.git");
    const cwd = path.join(root, "copy");
    const git = (args: string[], directory = seed) => execCommand("git", args, { cwd: directory });
    await execCommand("git", ["init", seed]);
    await writeFile(path.join(seed, "a.txt"), "initial\n");
    await git(["add", "."]);
    await git([
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.test",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-m",
      "Initial",
    ]);
    await execCommand("git", ["clone", "--bare", seed, remote]);
    if (id === "git") {
      await execCommand("git", ["clone", remote, cwd]);
      await git(["branch", "feature"], cwd);
      await git(["branch", "unrelated"], cwd);
    } else {
      const source = path.join(root, "source");
      await execCommand("git", ["clone", remote, source]);
      await execCommand("jj", ["git", "init", "--colocate", source]);
      await execCommand("jj", ["workspace", "add", "--no-colocate", cwd], { cwd: source });
      await execCommand("jj", ["bookmark", "create", "feature", "unrelated", "-r", "@-"], { cwd });
    }
    const handler = createVcsHandler(id === "git" ? gitProvider : jjProvider);
    try {
      const detection = await handler.handle({ kind: "detect", cwd });
      if (detection.kind !== "detect" || detection.detection.status !== "available")
        throw new Error("Missing binding");
      const binding = detection.detection.binding;
      const response = await handler.handle({
        kind: "publication.resolve",
        binding,
        selection: { remote: "origin", headRef: "feature", baseRef: "main" },
      });
      if (response.kind !== "publication") throw new Error("Missing publication");
      const target = response.publication;
      const request = {
        kind: "publication.publish" as const,
        binding,
        target,
        operationId: "publish",
      };
      await handler.handle(request);
      await expect
        .poll(async () => {
          const operation = await handler.handle({ kind: "operation", operationId: "publish" });
          if (operation.kind !== "operation") throw new Error("Missing operation");
          if (operation.operation.status === "failed")
            throw new Error(JSON.stringify(operation.operation.error));
          return operation.operation.status;
        })
        .toBe("succeeded");
      const refs = (await git(["--git-dir", remote, "for-each-ref", "--format=%(refname)"])).stdout;
      expect(refs).toContain("refs/heads/feature\n");
      expect(refs).not.toContain("refs/heads/unrelated");
      expect(
        (await git(["--git-dir", remote, "rev-parse", "refs/heads/feature"])).stdout.trim(),
      ).toBe(target.headRevision);
      await handler.handle({ kind: "publication.verify", binding, target });
      await verifyPublicationWorkflow({ root, cwd, target, providerId: id, handler });
      expect(await handler.handle({ kind: "publication.archive-safety", binding, target })).toEqual(
        { kind: "publication.archive-safety", safe: true },
      );
      await writeFile(path.join(cwd, "a.txt"), "Unpublished work\n");
      expect(await handler.handle({ kind: "publication.archive-safety", binding, target })).toEqual(
        { kind: "publication.archive-safety", safe: false },
      );
      if (id === "git") {
        await git(
          [
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.test",
            "-c",
            "commit.gpgsign=false",
            "commit",
            "-am",
            "New work",
          ],
          cwd,
        );
        await git(["branch", "-f", "feature", "HEAD"], cwd);
      } else {
        await execCommand("jj", ["describe", "-m", "New work"], { cwd });
        await execCommand("jj", ["bookmark", "set", "feature", "-r", "@"], { cwd });
      }
      await handler.handle({ ...request, operationId: "stale-target" });
      await expect
        .poll(() => handler.handle({ kind: "operation", operationId: "stale-target" }), {
          timeout: 10_000,
        })
        .toMatchObject({
          kind: "operation",
          operation: { status: "failed", error: { code: "outdated" } },
        });
      expect(
        (await git(["--git-dir", remote, "rev-parse", "refs/heads/feature"])).stdout.trim(),
      ).toBe(target.headRevision);
      const backend =
        id === "git"
          ? path.join(cwd, ".git")
          : (
              await execCommand("jj", ["git", "root", "--ignore-working-copy"], { cwd })
            ).stdout.trim();
      await git(["--git-dir", backend, "config", "--add", "remote.origin.pushurl", remote]);
      await git(["--git-dir", backend, "config", "--add", "remote.origin.pushurl", remote]);
      await expect(
        handler.handle({
          kind: "publication.resolve",
          binding,
          selection: { remote: "origin", headRef: "feature", baseRef: "main" },
        }),
      ).rejects.toMatchObject({ problem: { code: "remote" } });
      await rm(remote, { recursive: true });
      expect(await handler.handle(request)).toMatchObject({
        kind: "operation",
        operation: { status: "succeeded", result: target },
      });
    } finally {
      handler.dispose();
    }
  });
});

async function verifyPublicationWorkflow(input: {
  root: string;
  cwd: string;
  target: import("@getpaseo/plugin").VcsPublication;
  providerId: string;
  handler: ReturnType<typeof import("@getpaseo/plugin/server/vcs").createVcsHandler>;
}) {
  const {
    createPersistedProjectRecord,
    createPersistedWorkspaceRecord,
    FileBackedProjectRegistry,
    FileBackedWorkspaceRegistry,
  } = await import("../workspace-registry.js");
  const { handleWorkspaceVcsRequest } = await import("../session/vcs/index.js");
  const { VcsInboundMessageSchema } = await import("@getpaseo/protocol/vcs-rpc");
  const { createForgeResolver } = await import("../../services/forge-resolver.js");
  const { createGitHubService } = await import("../../services/github-service.js");
  const log = pino({ level: "silent" });
  const projects = new FileBackedProjectRegistry(path.join(input.root, "projects.json"), log);
  const workspaces = new FileBackedWorkspaceRegistry(path.join(input.root, "workspaces.json"), log);
  await projects.initialize();
  await workspaces.initialize();
  const timestamp = new Date().toISOString();
  await projects.upsert(
    createPersistedProjectRecord({
      projectId: "project",
      rootPath: input.cwd,
      kind: "git",
      displayName: "Publication",
      vcsProviderId: input.providerId,
      createdAt: timestamp,
      updatedAt: timestamp,
    }),
  );
  await workspaces.upsert(
    createPersistedWorkspaceRecord({
      projectId: "project",
      workspaceId: "workspace",
      cwd: input.cwd,
      kind: "directory",
      displayName: "Task",
      createdAt: timestamp,
      updatedAt: timestamp,
    }),
  );
  let pushes = 0;
  let losePushOutcome = false;
  let attempts = 0;
  let merges = 0;
  let current: import("../../services/forge-service.js").CurrentPullRequestStatus | null = null;
  let releaseCreate!: () => void;
  const createGate = new Promise<void>((resolve) => {
    releaseCreate = resolve;
  });
  const adapter = {
    ...createGitHubService(),
    invalidate() {},
    async getCurrentPullRequestStatus(options: { cwd: string; headRef: string; headSha?: string }) {
      expect(options).toMatchObject({
        cwd: input.cwd,
        headRef: input.target.headRef,
        headSha: input.target.headRevision,
      });
      return current;
    },
    async createPullRequest(
      options: import("../../services/forge-service.js").CreatePullRequestOptions,
    ) {
      expect(options).toMatchObject({
        cwd: input.cwd,
        head: input.target.headRef,
        base: input.target.baseRef,
        title: "Task",
      });
      attempts++;
      if (attempts === 1) throw new Error("Forge is temporarily unavailable");
      await createGate;
      current = {
        number: 7,
        url: "https://forge.test/repo/pull/7",
        title: "Task",
        state: "open",
        baseRefName: input.target.baseRef,
        headRefName: input.target.headRef,
        isMerged: false,
        mergeable: "MERGEABLE",
        checks: [{ name: "Tests", status: "success", url: null }],
        checksStatus: "success",
        reviewDecision: "approved",
      };
      return { number: 7, url: current.url };
    },
    async mergePullRequest() {
      merges++;
      return { success: true as const };
    },
  };
  const plugins = {
    listVcsProviders: () => [{ id: input.providerId, pluginId: "fixture", label: "Fixture" }],
    async invokeVcs(_id: string, request: import("@getpaseo/plugin").VcsRequest) {
      if (request.kind === "publication.publish") {
        pushes++;
        if (losePushOutcome)
          return {
            kind: "operation" as const,
            operation: { id: request.operationId, status: "unknown" as const },
          };
      }
      return input.handler.handle(request);
    },
  };
  const forge = {
    ...createForgeResolver(),
    async resolveRepository(repositoryUrl: string) {
      expect(repositoryUrl).toBe(input.target.repositoryUrl);
      return { forge: "fixture", host: "forge.test", service: adapter };
    },
  };
  const deps = { projects, workspaces, plugins, forge };
  const call = (request: unknown) =>
    handleWorkspaceVcsRequest(VcsInboundMessageSchema.parse(request), deps);
  const create = (operationId: string, publish: boolean) => ({
    type: "vcs.change-request.execute.request",
    requestId: "create",
    workspaceId: "workspace",
    operationId,
    target: input.target,
    input: { action: "create", title: "Task", body: "Description", publish },
  });
  const operation = async (operationId: string) => {
    const response = await call({
      type: "vcs.operations.get.request",
      requestId: "poll",
      workspaceId: "workspace",
      providerId: input.providerId,
      operationId,
    });
    if (response.type !== "vcs.operations.get.response" || !response.payload.result)
      throw new Error(JSON.stringify(response));
    return response.payload.result;
  };
  expect(await call(create("first", true))).toMatchObject({ payload: { error: null } });
  await expect
    .poll(async () => (await operation("first")).status, { timeout: 10_000 })
    .toBe("failed");
  expect(await operation("first")).toMatchObject({
    result: { publication: input.target, stage: "published" },
    error: { message: "Forge is temporarily unavailable" },
  });
  expect(pushes).toBe(1);
  await call(create("first", true));
  expect(pushes).toBe(1);
  expect(attempts).toBe(1);
  await call(create("retry", false));
  // Retry still validates against the real repository and remote before reaching the forge.
  await expect
    .poll(
      async () => {
        const state = await operation("retry");
        if (state.status === "failed" || state.status === "unknown")
          throw new Error(JSON.stringify(state));
        return attempts;
      },
      { timeout: 10_000 },
    )
    .toBe(2);
  expect(await operation("retry")).toMatchObject({
    status: "running",
    result: { stage: "published" },
  });
  // Reconnect/repeat lookup while the forge call is in progress cannot create another request.
  await call(create("retry", false));
  expect(attempts).toBe(2);
  releaseCreate();
  await expect
    .poll(async () => (await operation("retry")).status, { timeout: 10_000 })
    .toBe("succeeded");
  expect(await operation("retry")).toMatchObject({
    result: { stage: "created", changeRequest: { number: 7 } },
  });
  expect(pushes).toBe(1);
  expect(
    await call({
      type: "vcs.change-request.get.request",
      requestId: "status",
      workspaceId: "workspace",
      target: input.target,
    }),
  ).toMatchObject({
    payload: {
      error: null,
      result: {
        forge: "fixture",
        status: {
          number: 7,
          checksStatus: "success",
          checks: [{ name: "Tests", status: "success" }],
        },
      },
    },
  });
  const merge = (operationId: string, number: number) => ({
    type: "vcs.change-request.execute.request",
    requestId: "merge",
    workspaceId: "workspace",
    operationId,
    target: input.target,
    input: {
      action: "merge",
      number,
      url: "https://forge.test/repo/pull/7",
      mergeMethod: "squash",
    },
  });
  await call(merge("wrong-pr", 8));
  await expect
    .poll(async () => (await operation("wrong-pr")).status, { timeout: 10_000 })
    .toBe("failed");
  expect(merges).toBe(0);
  await call(merge("merge", 7));
  await expect
    .poll(async () => (await operation("merge")).status, { timeout: 10_000 })
    .toBe("succeeded");
  expect(merges).toBe(1);
  const drift = await call({
    type: "vcs.publication.publish.request",
    requestId: "drift",
    workspaceId: "workspace",
    operationId: "retry",
    target: input.target,
  });
  expect(drift).toMatchObject({
    payload: { error: { message: "Operation ID was already used for another request" } },
  });
  losePushOutcome = true;
  await call(create("uncertain-push", true));
  await expect
    .poll(async () => (await operation("uncertain-push")).status, { timeout: 10_000 })
    .toBe("unknown");
  expect(await operation("uncertain-push")).toMatchObject({
    result: { stage: "ready" },
    error: { message: "Push outcome is unknown; refresh before retrying" },
  });
  expect(attempts).toBe(2);
  const reloadedWorkspaces = new FileBackedWorkspaceRegistry(
    path.join(input.root, "workspaces.json"),
    log,
  );
  await reloadedWorkspaces.initialize();
  const unknown = await handleWorkspaceVcsRequest(
    VcsInboundMessageSchema.parse({
      type: "vcs.operations.get.request",
      requestId: "unknown",
      workspaceId: "workspace",
      providerId: input.providerId,
      operationId: "retry",
    }),
    { ...deps, workspaces: reloadedWorkspaces },
  );
  expect(unknown).toMatchObject({ payload: { result: { id: "retry", status: "unknown" } } });
}

describe("VCS managed observation", () => {
  it.each(["git", "jj"])(
    "shares %s watches, observes tracked ignored files and releases every handle",
    async (id) => {
      const { execCommand } = await import("@getpaseo/plugin/server");
      const { createVcsHandler } = await import("@getpaseo/plugin/server/vcs");
      const { gitProvider } = await import("../../../../../plugins/git-vcs/server/provider.js");
      const { jjProvider } = await import("../../../../../plugins/jj-vcs/server/provider.js");
      const { WorkspaceVcsObservation } = await import("../workspace-vcs-observation.js");
      const parent = await mkdtemp(path.join(tmpdir(), "vcs-observe-"));
      temporaryDirectories.push(parent);
      const cwd = path.join(parent, "repository");
      await mkdir(cwd);
      await mkdir(path.join(cwd, "src"));
      await mkdir(path.join(cwd, "ignored"));
      await writeFile(path.join(cwd, ".gitignore"), "ignored/\n");
      await writeFile(path.join(cwd, "src/a.txt"), "initial\n");
      await writeFile(path.join(cwd, "ignored/tracked.txt"), "tracked\n");
      await writeFile(path.join(cwd, "ignored/dependency.txt"), "ignored\n");
      const git = (args: string[]) => execCommand("git", args, { cwd });
      await git(["init"]);
      await git(["add", "."]);
      await git(["add", "-f", "ignored/tracked.txt"]);
      await git([
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.test",
        "commit",
        "-m",
        "Initial",
      ]);
      if (id === "jj") await execCommand("jj", ["git", "init", "--colocate"], { cwd });
      const handler = createVcsHandler(id === "git" ? gitProvider : jjProvider);
      const service = new WorkspaceVcsObservation({
        listVcsProviders: () => [{ id, pluginId: "fixture", label: id }],
        invokeVcs: (_id, request) => handler.handle(request),
      });
      const updates: import("../workspace-vcs-observation.js").VcsObservationValue[] = [];
      try {
        const detection = await handler.handle({ kind: "detect", cwd });
        if (detection.kind !== "detect" || detection.detection.status !== "available")
          throw new Error("Missing binding");
        const binding = detection.detection.binding;
        const first = await service.subscribe(binding, () => {});
        const second = await service.subscribe(
          { ...binding, cwd: path.join(cwd, "src") },
          (value) => updates.push(value),
        );
        expect(service.getDiagnostics()).toMatchObject({ workingCopies: 1, subscriptions: 2 });
        const before = await handler.handle({ kind: "observation", binding });
        await handler.handle({ kind: "snapshot", binding });
        expect(await handler.handle({ kind: "observation", binding })).toEqual(before);
        const handles = service.getDiagnostics().nativeHandleCount;
        expect(handles).toBeGreaterThan(0);
        await first.unsubscribe();
        expect(service.getDiagnostics().nativeHandleCount).toBe(handles);
        await writeFile(path.join(cwd, "ignored/tracked.txt"), "changed tracked file\n");
        await expect
          .poll(() => updates.at(-1)?.result?.files)
          .toEqual(
            expect.arrayContaining([expect.objectContaining({ path: "ignored/tracked.txt" })]),
          );
        expect(updates.at(-1)?.result?.binding.cwd).toBe(path.join(cwd, "src"));
        await rm(cwd, { recursive: true, force: true });
        await second.unsubscribe();
        expect(service.getDiagnostics()).toMatchObject({
          workingCopies: 0,
          subscriptions: 0,
          roots: 0,
          activeObservationCount: 0,
          nativeHandleCount: 0,
          pendingEventCount: 0,
          pendingReconciliationWorkCount: 0,
        });
      } finally {
        await service.close();
        handler.dispose();
      }
    },
  );

  it("invalidates other jj workspaces and leaves stale working copies unrepaired", async () => {
    const { execCommand } = await import("@getpaseo/plugin/server");
    const { createVcsHandler } = await import("@getpaseo/plugin/server/vcs");
    const { jjProvider } = await import("../../../../../plugins/jj-vcs/server/provider.js");
    const { WorkspaceVcsObservation } = await import("../workspace-vcs-observation.js");
    const root = await mkdtemp(path.join(tmpdir(), "vcs-observe-stale-"));
    temporaryDirectories.push(root);
    const first = path.join(root, "first"),
      second = path.join(root, "second");
    await execCommand("jj", ["git", "init", first]);
    await writeFile(path.join(first, "a.txt"), "initial\n");
    await execCommand("jj", ["describe", "-m", "First"], { cwd: first });
    await execCommand("jj", ["workspace", "add", "--no-colocate", second], { cwd: first });
    const handler = createVcsHandler(jjProvider);
    const service = new WorkspaceVcsObservation({
      listVcsProviders: () => [{ id: "jj", pluginId: "fixture", label: "jj" }],
      invokeVcs: (_id, request) => handler.handle(request),
    });
    const updates: import("../workspace-vcs-observation.js").VcsObservationValue[] = [];
    try {
      const bind = async (cwd: string) => {
        const value = await handler.handle({ kind: "detect", cwd });
        if (value.kind !== "detect" || value.detection.status !== "available")
          throw new Error("Missing binding");
        return value.detection.binding;
      };
      const a = await service.subscribe(await bind(first), (value) => updates.push(value));
      const b = await service.subscribe(await bind(second), () => {});
      expect(service.getDiagnostics()).toMatchObject({ workingCopies: 2, roots: 6 });
      const checkout = await readFile(path.join(first, ".jj/working_copy/checkout"));
      await writeFile(path.join(second, "a.txt"), "changed in a neighboring workspace\n");
      await execCommand(
        "jj",
        ["restore", "--from", "@", "--into", a.snapshot.current!.id, "--", "a.txt"],
        { cwd: second },
      );
      await expect.poll(() => updates.at(-1)?.result?.state, { timeout: 10000 }).toBe("stale");
      expect(await readFile(path.join(first, ".jj/working_copy/checkout"))).toEqual(checkout);
      await Promise.all([a.unsubscribe(), b.unsubscribe()]);
      expect(service.getDiagnostics().nativeHandleCount).toBe(0);
    } finally {
      await service.close();
      handler.dispose();
    }
  });
});

it("coalesces VCS file bursts, ignores snapshot metadata writes and suspends an unloaded plugin", async () => {
  const { WorkspaceVcsObservation } = await import("../workspace-vcs-observation.js");
  const { createFileObserver } = await import("../file-observer/index.js");
  const { VcsError } = await import("@getpaseo/plugin/server/vcs");
  type Callback = import("../file-observer/index.js").FileObserverCallback;
  const observer = createFileObserver();
  const callbacks = new Map<string, Callback>();
  let watchingFailed = false;
  vi.spyOn(observer, "subscribe").mockImplementation(async (root, callback) => {
    if (watchingFailed) throw new Error("ENOSPC: test watcher limit");
    callbacks.set(root, callback);
    return {
      updateIgnore: async () => {},
      unsubscribe: async () => {
        callbacks.delete(root);
      },
    };
  });
  const binding = {
    providerId: "example",
    repositoryId: "/metadata",
    workingCopyId: "/working",
    cwd: "/working",
    root: "/working",
  };
  const listeners = new Set<() => void>();
  let available = true,
    reads = 0,
    fingerprint = "initial";
  const service = new WorkspaceVcsObservation(
    {
      listVcsProviders: () =>
        available ? [{ id: "example", label: "Example", pluginId: "fixture" }] : [],
      subscribe: (callback) => {
        listeners.add(callback);
        return () => {
          listeners.delete(callback);
        };
      },
      invokeVcs: async (_id, request) => {
        if (!available) throw new VcsError({ code: "unavailable", message: "Plugin unloaded" });
        if (request.kind === "observation")
          return {
            kind: "observation",
            plan: {
              fingerprint,
              roots: [
                { path: "/working", kind: "files", scope: "working-copy" },
                { path: "/metadata", scope: "repository" },
              ],
            },
          };
        if (request.kind !== "snapshot") throw new Error("Unexpected request");
        reads++;
        callbacks.get("/metadata")?.(null, [{ path: "/metadata/lock", type: "update" }]);
        return {
          kind: "snapshot",
          snapshot: {
            binding,
            version: fingerprint,
            current: null,
            refs: [],
            files: [],
            actions: [],
            capabilities: [],
            state: "ready",
          },
        };
      },
    },
    observer,
  );
  vi.useFakeTimers();
  const updates: import("../workspace-vcs-observation.js").VcsObservationValue[] = [];
  try {
    const subscription = await service.subscribe(binding, (value) => updates.push(value));
    await vi.advanceTimersByTimeAsync(5000);
    expect(reads).toBe(1);
    for (let i = 0; i < 100; i++)
      callbacks.get("/working")!(null, [{ path: `/working/${i}`, type: "update" }]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(reads).toBe(2);
    fingerprint = "external";
    callbacks.get("/metadata")!(null, [{ path: "/metadata/head", type: "create" }]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(reads).toBe(3);
    expect(updates.at(-1)?.result?.version).toBe("external");
    const explicit = await Promise.all([service.snapshot(binding), service.snapshot(binding)]);
    expect(explicit.map((snapshot) => snapshot.version)).toEqual(["external", "external"]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(reads).toBe(4);
    available = false;
    for (const listener of listeners) listener();
    await vi.advanceTimersByTimeAsync(1000);
    expect(updates.at(-1)?.error?.message).toBe("Plugin unloaded");
    expect(callbacks.size).toBe(0);
    expect(service.getDiagnostics().polling).toBe(0);
    available = true;
    watchingFailed = true;
    for (const listener of listeners) listener();
    await vi.advanceTimersByTimeAsync(1000);
    expect(updates.at(-1)?.error).toBeNull();
    expect(callbacks.size).toBe(0);
    expect(service.getDiagnostics().polling).toBe(1);
    const beforePoll = reads;
    await vi.advanceTimersByTimeAsync(6000);
    expect(reads).toBe(beforePoll + 1);
    watchingFailed = false;
    await vi.advanceTimersByTimeAsync(11000);
    expect(reads).toBe(beforePoll + 2);
    expect(callbacks.size).toBe(2);
    expect(service.getDiagnostics().polling).toBe(0);
    await subscription.unsubscribe();
    expect(callbacks.size).toBe(0);
    expect(listeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    await service.close();
    await expect(service.subscribe(binding, () => {})).rejects.toThrow("service is closed");
  } finally {
    await service.close();
    vi.useRealTimers();
  }
});

it("releases a VCS source cancelled before bootstrap without creating late watchers", async () => {
  const {
    FileBackedProjectRegistry,
    FileBackedWorkspaceRegistry,
    createPersistedProjectRecord,
    createPersistedWorkspaceRecord,
  } = await import("../workspace-registry.js");
  const { SessionDelivery } = await import("../session/owned-subscriptions/index.js");
  const { handleVcsObservation } = await import("../session/vcs/observation.js");
  const { resolveWorkspaceVcsObservation } = await import("../workspace-vcs-observation.js");
  const root = await mkdtemp(path.join(tmpdir(), "vcs-bootstrap-cancel-"));
  temporaryDirectories.push(root);
  const log = pino({ level: "silent" });
  const projects = new FileBackedProjectRegistry(path.join(root, "projects.json"), log);
  const workspaces = new FileBackedWorkspaceRegistry(path.join(root, "workspaces.json"), log);
  await projects.initialize();
  await workspaces.initialize();
  const timestamp = new Date().toISOString();
  await projects.upsert(
    createPersistedProjectRecord({
      projectId: "project",
      rootPath: root,
      kind: "non_git",
      displayName: "Project",
      vcsProviderId: "example",
      createdAt: timestamp,
      updatedAt: timestamp,
    }),
  );
  await workspaces.upsert(
    createPersistedWorkspaceRecord({
      workspaceId: "workspace",
      projectId: "project",
      cwd: root,
      kind: "directory",
      displayName: "Workspace",
      createdAt: timestamp,
      updatedAt: timestamp,
    }),
  );
  const invokeVcs = vi.fn(async (): Promise<import("@getpaseo/plugin").VcsResponse> => {
    throw new Error("Cancelled bootstrap must not invoke VCS");
  });
  const plugins = {
    listVcsProviders: () => [{ id: "example", label: "Example", pluginId: "fixture" }],
    invokeVcs,
  };
  let enter!: () => void, proceed!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    proceed = resolve;
  });
  const get = workspaces.get.bind(workspaces);
  vi.spyOn(workspaces, "get").mockImplementationOnce(async (id) => {
    enter();
    await gate;
    return get(id);
  });
  const delivery = new SessionDelivery(() => {});
  const source = {};
  delivery.attach(source, true);
  const request = {
    type: "vcs.snapshot.get.request" as const,
    requestId: "bootstrap",
    workspaceId: "workspace",
    subscribe: {},
  };
  const opening = delivery.request(source, request, () =>
    handleVcsObservation(request, {
      plugins,
      projects,
      workspaces,
      delivery,
      supports: () => true,
      emit: () => {},
    }),
  );
  await entered;
  const closing = delivery.detach(source);
  proceed();
  await Promise.all([opening, closing]);
  expect(invokeVcs).not.toHaveBeenCalled();
  expect(delivery.registrationCount).toBe(0);
  const observation = resolveWorkspaceVcsObservation(plugins);
  expect(observation.getDiagnostics()).toMatchObject({
    subscriptions: 0,
    roots: 0,
    nativeHandleCount: 0,
  });
  await observation.close();
  await delivery.close();
});

it("cancels VCS observation during its metadata probe before starting a snapshot", async () => {
  const { WorkspaceVcsObservation } = await import("../workspace-vcs-observation.js");
  let enter!: () => void, proceed!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    proceed = resolve;
  });
  const binding = {
    providerId: "example",
    repositoryId: "/repo",
    workingCopyId: "/copy",
    root: "/copy",
    cwd: "/copy",
  };
  const invokeVcs = vi.fn(
    async (
      _id: string,
      request: import("@getpaseo/plugin").VcsRequest,
    ): Promise<import("@getpaseo/plugin").VcsResponse> => {
      if (request.kind !== "observation")
        throw new Error("Cancelled observation must not snapshot");
      enter();
      await gate;
      return {
        kind: "observation",
        plan: {
          fingerprint: "version",
          roots: [{ path: "/copy", kind: "files", scope: "working-copy" }],
        },
      };
    },
  );
  const service = new WorkspaceVcsObservation({
    listVcsProviders: () => [{ id: "example", label: "Example", pluginId: "fixture" }],
    invokeVcs,
  });
  const cancellation = new AbortController();
  const opening = service.subscribe(binding, () => {}, cancellation.signal);
  await entered;
  cancellation.abort();
  proceed();
  await expect(opening).rejects.toMatchObject({ problem: { code: "cancelled" } });
  expect(invokeVcs).toHaveBeenCalledTimes(1);
  expect(service.getDiagnostics()).toMatchObject({
    subscriptions: 0,
    roots: 0,
    nativeHandleCount: 0,
  });
  await service.close();
});

it("Git project source metadata reports the exact upstream and repository URL", async () => {
  const { execCommand } = await import("@getpaseo/plugin/server");
  const { gitProvider } = await import("../../../../../plugins/git-vcs/server/provider.js");
  const root = await mkdtemp(path.join(tmpdir(), "paseo-project-source-"));
  temporaryDirectories.push(root);
  const git = (args: string[]) => execCommand("git", args, { cwd: root });
  await git(["init", "-b", "main"]);
  await git([
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.test",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--allow-empty",
    "-m",
    "initial",
  ]);
  await git(["remote", "add", "origin", "https://example.test/repository.git"]);
  await git(["remote", "add", "upstream", "https://example.test/upstream.git"]);
  await git(["update-ref", "refs/remotes/upstream/trunk", "HEAD"]);
  await git(["branch", "--set-upstream-to", "upstream/trunk", "main"]);
  const context = { signal: new AbortController().signal };
  const detected = await gitProvider.detect(root, context);
  if (detected.status !== "available") throw new Error("No Git binding");
  const before = await gitProvider.snapshot(detected.binding, context);
  expect(before.data).toEqual({
    version: 1,
    data: {
      branch: "main",
      upstreamRef: "refs/remotes/upstream/trunk",
      remoteUrl: "https://example.test/repository.git",
    },
  });
  await git(["branch", "--unset-upstream"]);
  const after = await gitProvider.snapshot(detected.binding, context);
  expect(after.data).toEqual({
    version: 1,
    data: { branch: "main", upstreamRef: null, remoteUrl: "https://example.test/repository.git" },
  });
  expect(after.version).not.toBe(before.version);
});

describe("VCS comparison settings", () => {
  it.each(["git", "jj"])(
    "persists %s settings, inheritance and reset across registry reload",
    async (providerId) => {
      const { execCommand } = await import("@getpaseo/plugin/server");
      const { createVcsHandler } = await import("@getpaseo/plugin/server/vcs");
      const { gitProvider } = await import("../../../../../plugins/git-vcs/server/provider.js");
      const { jjProvider } = await import("../../../../../plugins/jj-vcs/server/provider.js");
      const { handleComparisonSettings } = await import("../session/vcs/comparison-settings.js");
      const {
        FileBackedProjectRegistry,
        FileBackedWorkspaceRegistry,
        createPersistedProjectRecord,
        createPersistedWorkspaceRecord,
      } = await import("../workspace-registry.js");
      const root = await mkdtemp(path.join(tmpdir(), "vcs-settings-"));
      temporaryDirectories.push(root);
      const cwd = path.join(root, "repo");
      await execCommand("git", ["init", cwd]);
      if (providerId === "jj") await execCommand("jj", ["git", "init", "--colocate", cwd]);
      const logger = pino({ level: "silent" });
      let projects = new FileBackedProjectRegistry(path.join(root, "projects.json"), logger);
      let workspaces = new FileBackedWorkspaceRegistry(path.join(root, "workspaces.json"), logger);
      await projects.initialize();
      await workspaces.initialize();
      const now = new Date().toISOString();
      await projects.upsert({
        ...createPersistedProjectRecord({
          projectId: "p",
          rootPath: cwd,
          kind: "git",
          displayName: "Project",
          vcsProviderId: providerId,
          createdAt: now,
          updatedAt: now,
        }),
        diffComparison: { mode: "base", baseRef: "legacy" },
      });
      await workspaces.upsert(
        createPersistedWorkspaceRecord({
          workspaceId: "w",
          projectId: "p",
          cwd,
          kind: "directory",
          displayName: "Workspace",
          createdAt: now,
          updatedAt: now,
        }),
      );
      const handler = createVcsHandler(providerId === "git" ? gitProvider : jjProvider);
      let loaded = true;
      const plugins = {
        listVcsProviders: () =>
          loaded ? [{ id: providerId, label: providerId, pluginId: providerId }] : [],
        invokeVcs: async (
          _providerId: string,
          request: import("@getpaseo/protocol/vcs").VcsRequest,
        ) => {
          if (!loaded) throw new Error("Plugin is unavailable");
          return handler.handle(request);
        },
      };
      const get = (scope: "project" | "workspace" = "workspace") =>
        handleComparisonSettings(
          {
            type: "vcs.comparison.get.request",
            requestId: "get",
            providerId,
            target:
              scope === "project"
                ? { kind: "project", projectId: "p" }
                : { kind: "workspace", workspaceId: "w" },
          },
          { projects, workspaces, plugins },
        );
      const set = (
        scope: "project" | "workspace",
        value: import("@getpaseo/protocol/vcs").VcsData | null,
      ) =>
        handleComparisonSettings(
          {
            type: "vcs.comparison.set.request",
            requestId: "set",
            providerId,
            target:
              scope === "project"
                ? { kind: "project", projectId: "p" }
                : { kind: "workspace", workspaceId: "w" },
            value,
          },
          { projects, workspaces, plugins },
        );
      const projectValue = {
        version: 1,
        data: { mode: providerId === "git" ? "all" : "base", baseRef: "main" },
      };
      const override = {
        version: 1,
        data: { mode: providerId === "git" ? "uncommitted" : "change" },
      };
      try {
        expect((await get()).effective).toEqual(
          providerId === "git" ? { version: 1, data: { mode: "all", baseRef: "legacy" } } : null,
        );
        await set("project", projectValue);
        expect(await get()).toEqual({
          providerId,
          selection: null,
          inherited: projectValue,
          effective: projectValue,
        });
        await set("workspace", override);
        expect((await get()).effective).toEqual(override);
        await expect(set("workspace", { version: 99, data: { mode: "bad" } })).rejects.toThrow();
        expect((await get()).effective).toEqual(override);
        projects = new FileBackedProjectRegistry(path.join(root, "projects.json"), logger);
        workspaces = new FileBackedWorkspaceRegistry(path.join(root, "workspaces.json"), logger);
        await projects.initialize();
        await workspaces.initialize();
        expect((await get()).effective).toEqual(override);
        await set("workspace", null);
        expect((await get()).effective).toEqual(projectValue);
        loaded = false;
        expect((await get()).effective).toEqual(projectValue);
        await expect(set("project", override)).rejects.toThrow();
        loaded = true;
        await set("project", null);
        expect((await get()).effective).toBeNull();
        await expect(
          handleComparisonSettings(
            {
              type: "vcs.comparison.get.request",
              requestId: "wrong",
              providerId: "other",
              target: { kind: "workspace", workspaceId: "w" },
            },
            { projects, workspaces, plugins },
          ),
        ).rejects.toThrow("changed");
      } finally {
        handler.dispose();
      }
    },
  );
});

describe("Git provider comparison bases", () => {
  it("uses forge, recovery metadata and remote HEAD facts without host Git policy", async () => {
    const { execCommand } = await import("@getpaseo/plugin/server");
    const { createGitProvider } = await import("../../../../../plugins/git-vcs/server/provider.js");
    const { gitSnapshotComparisonBase } =
      await import("../../../../../plugins/git-vcs/shared/comparison.js");
    const cwd = await mkdtemp(path.join(tmpdir(), "git-plugin-base-"));
    temporaryDirectories.push(cwd);
    const git = async (args: string[]) =>
      (await execCommand("git", ["-c", "commit.gpgsign=false", ...args], { cwd })).stdout.trim();
    await git(["init", "-b", "feature"]);
    await git([
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.test",
      "commit",
      "--allow-empty",
      "-m",
      "base",
    ]);
    const revision = await git(["rev-parse", "HEAD"]);
    await git(["branch", "main"]);
    await git(["remote", "add", "origin", "https://forge.test/fork/repo.git"]);
    await git(["remote", "add", "upstream", "git@forge.test:team/repo.git"]);
    await git(["update-ref", "refs/remotes/origin/main", revision]);
    await git(["update-ref", "refs/remotes/upstream/trunk", revision]);
    await git(["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
    await git(["config", "branch.feature.remote", "origin"]);
    let facts: import("@getpaseo/plugin").VcsComparisonContext = {
      workingCopy: null,
      changeRequest: null,
      changeRequestError: null,
      observedHeadRef: "feature",
    };
    const provider = createGitProvider({
      comparisonContext: async () => facts,
      resolveChangeRequest: async () => {
        throw new Error("Unexpected checkout");
      },
      listLocalFiles: async () => [],
    });
    const context = { signal: new AbortController().signal };
    const detection = await provider.detect(cwd, context);
    if (detection.status !== "available") throw new Error("Missing Git binding");
    const binding = detection.binding;
    const read = async () => {
      const snapshot = await provider.snapshot(binding, context);
      return { snapshot, base: gitSnapshotComparisonBase.parse(snapshot.data).data.comparisonBase };
    };
    expect((await read()).base).toMatchObject({ baseRef: "refs/remotes/origin/main", error: null });
    const before = await provider.observation!(binding, context);
    facts = {
      ...facts,
      changeRequest: {
        url: "https://forge.test/team/repo/pull/7",
        headRef: "feature",
        baseRef: "trunk",
      },
    };
    expect((await provider.observation!(binding, context)).fingerprint).not.toBe(
      before.fingerprint,
    );
    const published = await read();
    expect(published.snapshot.workingComparison).toMatchObject({
      data: { data: { version: published.snapshot.version } },
    });
    if (!provider.diff) throw new Error("Git must provide diff");
    expect(await provider.diff(binding, published.snapshot.workingComparison!, context)).toBe("");

    expect(published.base).toMatchObject({ baseRef: "refs/remotes/upstream/trunk", error: null });
    facts = { ...facts, changeRequest: null, changeRequestError: "Forge offline" };
    const offline = await read();
    expect(offline.base).toMatchObject({
      baseRef: "refs/remotes/upstream/trunk",
      warning: "Forge offline",
    });
    expect(offline.snapshot.version).not.toBe(published.snapshot.version);
    if (!provider.history) throw new Error("Git must provide history");
    expect(
      await provider.history(binding, { version: published.snapshot.version, limit: 5 }, context),
    ).toMatchObject({ revisions: [{ id: revision }] });
    facts = { ...facts, changeRequestError: null, workingCopy: { binding, owned: true } };
    const metadataDir = path.join(await git(["rev-parse", "--absolute-git-dir"]), "paseo");
    await mkdir(metadataDir);
    await writeFile(
      path.join(metadataDir, "worktree.json"),
      JSON.stringify({ baseRefName: "main" }),
    );
    expect((await read()).base).toMatchObject({ baseRef: "refs/heads/main", error: null });
    facts = {
      ...facts,
      workingCopy: {
        binding,
        owned: true,
        data: {
          version: 2,
          data: {
            branch: "feature",
            revision,
            metadata: {
              version: 2,
              baseRef: "refs/remotes/upstream/trunk",
              baseRefName: "trunk",
              changeRequestLookupTarget: { headRef: "feature", localBranchName: "feature" },
            },
          },
        },
      },
    };
    expect((await read()).base.baseRef).toBe("refs/remotes/upstream/trunk");
    facts = { ...facts, workingCopy: { binding, owned: false } };
    expect((await read()).base.baseRef).toBe("refs/remotes/origin/main");
    await git(["config", "--unset", "branch.feature.remote"]);
    expect((await read()).base.error).toContain("uniquely identify");
    facts = {
      ...facts,
      changeRequest: {
        url: "https://forge.test/team/repo/-/merge_requests/7",
        headRef: "feature",
        baseRef: "trunk",
      },
    };
    expect((await read()).base.baseRef).toBe("refs/remotes/upstream/trunk");
    await git(["remote", "add", "duplicate", "https://forge.test/team/repo.git"]);
    await git(["update-ref", "refs/remotes/duplicate/trunk", revision]);
    expect((await read()).base.error).toContain("uniquely identify");
  });
});

async function jjRewriteFixture() {
  const { execCommand } = await import("@getpaseo/plugin/server");
  const { jjProvider } = await import("../../../../../plugins/jj-vcs/server/provider.js");
  const { createVcsHandler } = await import("@getpaseo/plugin/server/vcs");
  const cwd = await mkdtemp(path.join(tmpdir(), "paseo-jj-rewrite-"));
  temporaryDirectories.push(cwd);
  const jj = async (...args: string[]) => (await execCommand("jj", args, { cwd })).stdout.trim();
  const identity = async () => ({
    id: await jj("log", "--no-graph", "-r", "@", "-T", "commit_id"),
    changeId: await jj("log", "--no-graph", "-r", "@", "-T", "change_id"),
  });
  await jj("git", "init");
  await writeFile(path.join(cwd, "a.txt"), "base\n");
  await jj("describe", "-m", "Base");
  const base = await identity();
  await jj("new", "-m", "Source");
  await writeFile(path.join(cwd, "a.txt"), "source\n");
  const source = await identity();
  await jj("new", "-m", "Child");
  await writeFile(path.join(cwd, "child.txt"), "child data\n");
  const child = await identity();
  await jj("new", base.id, "-m", "Destination");
  await writeFile(path.join(cwd, "a.txt"), "destination\n");
  const destination = await identity();
  await jj("edit", child.id);
  const handler = createVcsHandler(jjProvider);
  const detected = await handler.handle({ kind: "detect", cwd });
  if (detected.kind !== "detect" || detected.detection.status !== "available")
    throw new Error("Missing binding");
  const binding = detected.detection.binding;
  const snapshot = async () => {
    const result = await handler.handle({ kind: "snapshot", binding });
    if (result.kind !== "snapshot") throw new Error("Missing snapshot");
    return result.snapshot;
  };
  const request = async (action: string, operationId = action) => ({
    kind: "execute" as const,
    binding,
    version: (await snapshot()).version,
    action,
    operationId,
    input: { revision: source.id, destination: destination.id },
  });
  const operation = async (operationId: string) => {
    const result = await handler.handle({ kind: "operation", operationId });
    if (result.kind !== "operation") throw new Error("Missing operation");
    return result.operation;
  };
  const rows = async () => {
    const result = await handler.handle({ kind: "history", binding, limit: 100 });
    if (result.kind !== "history") throw new Error("Missing history");
    return result.revisions;
  };
  return {
    cwd,
    jj,
    base,
    source,
    child,
    destination,
    handler,
    provider: jjProvider,
    binding,
    snapshot,
    request,
    operation,
    rows,
  };
}

describe("jj local rewrite contract", () => {
  it.each(["edit", "rebase", "abandon"])(
    "%s preserves the intended graph and replays only once",
    async (action) => {
      const f = await jjRewriteFixture();
      try {
        const request = await f.request(action);
        await Promise.all([f.handler.handle(request), f.handler.handle(request)]);
        await expect
          .poll(async () => (await f.operation(action)).status, { timeout: 10_000 })
          .toBe("succeeded");
        const snapshot = await f.snapshot();
        const rows = await f.rows();
        const source = rows.find((row) => row.changeId === f.source.changeId);
        const child = rows.find((row) => row.changeId === f.child.changeId);
        expect(child).toBeDefined();
        expect(rows.find((row) => row.changeId === f.destination.changeId)?.id).toBe(
          f.destination.id,
        );
        if (action === "edit") {
          expect(snapshot.current?.id).toBe(f.source.id);
          expect(child?.id).toBe(f.child.id);
          expect(await f.jj("file", "show", "-r", f.child.id, "child.txt")).toBe("child data");
          expect(await readFile(path.join(f.cwd, "a.txt"), "utf8")).toBe("source\n");
        } else {
          expect(child?.parents).toEqual([f.base.id]);
          expect(child?.id).not.toBe(f.child.id);
          expect(await readFile(path.join(f.cwd, "child.txt"), "utf8")).toBe("child data\n");
          if (action === "rebase") {
            expect(source?.parents).toEqual([f.destination.id]);
            expect(source?.conflict).toBe(true);
          } else expect(source).toBeUndefined();
        }
        await f.handler.handle(request);
        expect((await f.snapshot()).version).toBe(snapshot.version);
        await expect(f.handler.handle({ ...request, input: {} })).rejects.toThrow(
          "Operation ID was already used",
        );
      } finally {
        f.handler.dispose();
      }
    },
  );

  it.each(["edit", "rebase", "abandon"])(
    "%s rejects external changes and invalid exact targets without rewriting",
    async (action) => {
      const f = await jjRewriteFixture();
      try {
        const request = await f.request(action);
        await f.jj("describe", "-r", f.source.id, "-m", "External rewrite");
        const external = await f.snapshot();
        await f.handler.handle(request);
        await expect
          .poll(() => f.operation(action), { timeout: 10_000 })
          .toMatchObject({ status: "failed", error: { code: "outdated" } });
        expect((await f.snapshot()).version).toBe(external.version);
        const rows = await f.rows();
        expect(rows.find((row) => row.changeId === f.source.changeId)?.description).toBe(
          "External rewrite\n",
        );
        for (const target of ["f".repeat(40), f.source.changeId]) {
          const invalid = {
            ...request,
            version: external.version,
            operationId: target,
            input: { ...request.input, revision: target },
          };
          await f.handler.handle(invalid);
          await expect
            .poll(async () => (await f.operation(target)).status, { timeout: 10_000 })
            .toBe("failed");
          expect((await f.snapshot()).version).toBe(external.version);
        }
      } finally {
        f.handler.dispose();
      }
    },
  );

  it.each(["edit", "rebase", "abandon"])(
    "%s rejects an immutable target without side effects",
    async (action) => {
      const f = await jjRewriteFixture();
      try {
        const request = await f.request(action);
        await f.handler.handle({
          ...request,
          input: { ...request.input, revision: "0".repeat(40) },
        });
        await expect
          .poll(async () => (await f.operation(action)).status, { timeout: 10_000 })
          .toBe("failed");
        expect((await f.snapshot()).version).toBe(request.version);
      } finally {
        f.handler.dispose();
      }
    },
  );
});

const jjFileRefActions = [
  "squash",
  "split",
  "bookmark-create",
  "bookmark-set",
  "bookmark-delete",
  "bookmark-track",
];
describe("jj rewrite cancellation", () => {
  it.each(["edit", "rebase", "abandon", ...jjFileRefActions])(
    "%s retains an unknown applied result and never runs a cancelled queued request",
    async (action) => {
      const f = jjFileRefActions.includes(action)
        ? await jjFileRefFixture(action)
        : await jjRewriteFixture();
      const { createVcsHandler } = await import("@getpaseo/plugin/server/vcs");
      let markApplied!: () => void;
      const applied = new Promise<void>((resolve) => {
        markApplied = resolve;
      });
      let executions = 0;
      const execute = f.provider.execute;
      if (!execute) throw new Error("Missing jj executor");
      const handler = createVcsHandler({
        ...f.provider,
        async execute(binding, id, input, context) {
          executions++;
          await execute(binding, id, input, context);
          // Delay only the reply. The real jj mutation has already completed.
          const interrupted = new Promise<never>((_resolve, reject) => {
            context.signal.addEventListener("abort", () => reject(context.signal.reason), {
              once: true,
            });
          });
          markApplied();
          return interrupted;
        },
      });
      try {
        const request = "actionRequest" in f ? f.actionRequest : await f.request(action);
        await handler.handle(request);
        await applied;
        await handler.handle({ ...request, operationId: "queued" });
        await handler.handle({ kind: "cancel", operationId: "queued" });
        await handler.handle({ kind: "cancel", operationId: action });
        await expect
          .poll(() => handler.handle({ kind: "operation", operationId: action }), {
            timeout: 10_000,
          })
          .toMatchObject({ operation: { status: "unknown", error: { code: "cancelled" } } });
        await expect
          .poll(() => handler.handle({ kind: "operation", operationId: "queued" }), {
            timeout: 10_000,
          })
          .toMatchObject({ operation: { status: "failed", error: { code: "cancelled" } } });
        const after = await f.snapshot();
        expect(after.version).not.toBe(request.version);
        await handler.handle(request);
        await handler.handle({ ...request, operationId: "queued" });
        expect(executions).toBe(1);
        expect((await f.snapshot()).version).toBe(after.version);
      } finally {
        handler.dispose();
        f.handler.dispose();
      }
    },
  );
});

describe("jj divergent rewrite targets", () => {
  it.each(["edit", "rebase", "abandon"])(
    "%s requires an exact revision when a change has diverged",
    async (action) => {
      const f = await jjRewriteFixture();
      try {
        const initial = await f.snapshot();
        await f.jj(
          "--at-op",
          initial.version,
          "describe",
          "-r",
          f.source.id,
          "-m",
          "First variant",
        );
        await f.jj(
          "--at-op",
          initial.version,
          "describe",
          "-r",
          f.source.id,
          "-m",
          "Second variant",
        );
        const state = await f.snapshot();
        const variants = (await f.rows()).filter((row) => row.changeId === f.source.changeId);
        expect(variants).toHaveLength(2);
        const request = {
          kind: "execute" as const,
          binding: f.binding,
          version: state.version,
          operationId: "ambiguous",
          action,
          input: { revision: f.source.changeId, destination: f.destination.id },
        };
        await f.handler.handle(request);
        await expect
          .poll(async () => (await f.operation("ambiguous")).status, { timeout: 10_000 })
          .toBe("failed");
        expect((await f.snapshot()).version).toBe(state.version);
        await f.handler.handle({
          ...request,
          operationId: "exact",
          input: { ...request.input, revision: variants[0]!.id },
        });
        await expect
          .poll(async () => (await f.operation("exact")).status, { timeout: 10_000 })
          .toBe("succeeded");
        const rows = await f.rows();
        expect(rows.some((row) => row.id === variants[1]!.id)).toBe(true);
        if (action === "edit") expect((await f.snapshot()).current?.id).toBe(variants[0]!.id);
        else expect(rows.some((row) => row.id === variants[0]!.id)).toBe(false);
      } finally {
        f.handler.dispose();
      }
    },
  );
});

it("jj abandon reports dependent conflicts and edit preserves their state", async () => {
  const f = await jjRewriteFixture();
  try {
    await writeFile(path.join(f.cwd, "a.txt"), "dependent change\n");
    await f.handler.handle(await f.request("abandon"));
    await expect
      .poll(async () => (await f.operation("abandon")).status, { timeout: 10_000 })
      .toBe("succeeded");
    const conflicted = await f.snapshot();
    expect(conflicted.current).toMatchObject({
      changeId: f.child.changeId,
      conflict: true,
      parents: [f.base.id],
    });
    expect(conflicted.files).toContainEqual(
      expect.objectContaining({ path: "a.txt", conflict: true }),
    );
    await f.jj("edit", f.destination.id);
    const request = await f.request("edit");
    await f.handler.handle({ ...request, input: { revision: conflicted.current!.id } });
    await expect
      .poll(async () => (await f.operation("edit")).status, { timeout: 10_000 })
      .toBe("succeeded");
    expect((await f.snapshot()).current).toMatchObject({
      id: conflicted.current!.id,
      conflict: true,
    });
    expect(await readFile(path.join(f.cwd, "a.txt"), "utf8")).toContain("<<<<<<<");
  } finally {
    f.handler.dispose();
  }
});

async function jjFileRefFixture(action: string) {
  const f = await jjRewriteFixture();
  const name = "topic@review";
  const selected = "selected (file).txt";
  if (action === "squash" || action === "split")
    await writeFile(path.join(f.cwd, selected), "selected data\n");
  if (action === "bookmark-set" || action === "bookmark-delete")
    await f.jj("bookmark", "create", JSON.stringify(name), "-r", f.source.id);
  if (action === "bookmark-track") {
    const { execCommand } = await import("@getpaseo/plugin/server");
    const remote = path.join(f.cwd, ".jj", "test-remote.git");
    await execCommand("git", ["init", "--bare", remote]);
    const backend = await f.jj("git", "root");
    await execCommand("git", [
      "--git-dir",
      backend,
      "push",
      remote,
      `${f.source.id}:refs/heads/${name}`,
    ]);
    await f.jj("git", "remote", "add", "origin", remote);
    await f.jj("--config", "git.auto-local-bookmark=false", "git", "fetch", "--remote", "origin");
  }
  const snapshot = await f.snapshot();
  return {
    ...f,
    name,
    selected,
    actionRequest: {
      kind: "execute" as const,
      binding: f.binding,
      version: snapshot.version,
      operationId: action,
      action,
      input: {
        revision:
          action === "squash" || action === "split" ? snapshot.current!.id : f.destination.id,
        destination: f.source.id,
        files: [selected],
        message: "Selected files",
        name,
        remote: "origin",
      },
    },
  };
}

describe("jj file and bookmark actions", () => {
  it.each(jjFileRefActions)(
    "%s applies the explicit selection and replays once",
    async (action) => {
      const f = await jjFileRefFixture(action);
      try {
        const before = await f.snapshot();
        if (action === "bookmark-set") {
          const preview = await f.handler.handle({
            kind: "actions.preview",
            binding: f.binding,
            version: before.version,
            action,
            input: f.actionRequest.input,
          });
          expect(preview).toMatchObject({
            kind: "actions.preview",
            preview: {
              revisions: [{ id: f.destination.id }],
              refs: [{ name: f.name, targets: [f.source.id] }],
            },
          });
          expect((await f.snapshot()).version).toBe(before.version);
        }
        await Promise.all([f.handler.handle(f.actionRequest), f.handler.handle(f.actionRequest)]);
        await expect
          .poll(() => f.operation(action), { timeout: 10_000 })
          .toMatchObject({ status: "succeeded" });
        const after = await f.snapshot();
        if (action === "squash" || action === "split") {
          expect(after.files.map((file) => file.path)).toEqual(["child.txt"]);
          expect(await readFile(path.join(f.cwd, f.selected), "utf8")).toBe("selected data\n");
          expect(await readFile(path.join(f.cwd, "child.txt"), "utf8")).toBe("child data\n");
          const parent = after.current!.parents[0]!;
          expect(
            await f.jj("file", "show", "-r", parent, `root-file:${JSON.stringify(f.selected)}`),
          ).toBe("selected data");
          if (action === "split")
            expect((await f.rows()).find((row) => row.id === parent)?.description).toBe(
              "Selected files\n",
            );
        } else {
          expect(after.current?.id).toBe(before.current?.id);
          const local = after.refs.find((ref) => ref.name === f.name && !ref.remote);
          if (action === "bookmark-delete") expect(local).toBeUndefined();
          else if (action === "bookmark-track") {
            expect(local?.targets).toEqual([f.source.id]);
            expect(
              after.refs.find((ref) => ref.name === f.name && ref.remote === "origin"),
            ).toMatchObject({ tracked: true });
          } else expect(local?.targets).toEqual([f.destination.id]);
        }
        await f.handler.handle(f.actionRequest);
        expect((await f.snapshot()).version).toBe(after.version);
      } finally {
        f.handler.dispose();
      }
    },
  );

  it.each(jjFileRefActions)(
    "%s rejects a stale context without applying the action",
    async (action) => {
      const f = await jjFileRefFixture(action);
      try {
        await writeFile(path.join(f.cwd, "external.txt"), "external data\n");
        const external = await f.snapshot();
        await f.handler.handle(f.actionRequest);
        await expect
          .poll(() => f.operation(action), { timeout: 10_000 })
          .toMatchObject({ status: "failed", error: { code: "outdated" } });
        expect((await f.snapshot()).version).toBe(external.version);
        expect(await readFile(path.join(f.cwd, "external.txt"), "utf8")).toBe("external data\n");
      } finally {
        f.handler.dispose();
      }
    },
  );

  it.each(["squash", "split"])("%s rejects missing files without rewriting", async (action) => {
    const f = await jjFileRefFixture(action);
    try {
      await f.handler.handle({
        ...f.actionRequest,
        input: { ...f.actionRequest.input, files: ["not-changed.txt"] },
      });
      await expect
        .poll(async () => (await f.operation(action)).status, { timeout: 10_000 })
        .toBe("failed");
      expect((await f.snapshot()).version).toBe(f.actionRequest.version);
    } finally {
      f.handler.dispose();
    }
  });
});
