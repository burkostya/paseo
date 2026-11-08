import { WebSocket } from "ws";
import {
  DaemonClient as PublicDaemonClient,
  type WebSocketLike,
} from "@getpaseo/client/internal/daemon-client";
import { expect, test } from "vitest";
import { createPaseoApi } from "@getpaseo/client";
import { DaemonClient } from "./test-utils/daemon-client.js";
import { createTestPaseoDaemon } from "./test-utils/paseo-daemon.js";

test("two SDK facades own combined agent lists and disposal preserves the other facade", async () => {
  const daemon = await createTestPaseoDaemon({ mcpEnabled: false });
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    appVersion: "0.8.0",
    capabilities: { owned_subscriptions: true },
  });
  const admin = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws`, appVersion: "0.8.0" });
  const app = createPaseoApi(client);
  const plugin = createPaseoApi(client);
  try {
    await admin.connect();
    await client.connect();
    const agent = await admin.createAgent({
      provider: "codex",
      cwd: daemon.staticDir,
      title: "Before",
    });
    const appUpdates: unknown[] = [];
    const pluginUpdates: unknown[] = [];
    app.agents.subscribe((update) => appUpdates.push(update));
    plugin.agents.subscribe((update) => pluginUpdates.push(update));
    const broad = await app.agents.list({ scope: "active", subscribe: {} });
    const filtered = await plugin.agents.list({
      scope: "active",
      filter: { labels: { role: "orchestrator" } },
      page: { limit: 100 },
      subscribe: {},
    });
    expect(broad.subscriptionId).toEqual(expect.any(String));
    expect(filtered.subscriptionId).toEqual(expect.any(String));
    expect(broad.subscriptionId).not.toBe(filtered.subscriptionId);
    expect(filtered.entries).toEqual([]);
    await admin.updateAgent(agent.id, { name: "After" });
    await expect
      .poll(() => appUpdates)
      .toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "upsert",
            subscriptionId: broad.subscriptionId,
            agent: expect.objectContaining({ id: agent.id, title: "After" }),
          }),
        ]),
      );
    expect(appUpdates).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "remove" })]),
    );
    expect(pluginUpdates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "remove",
          subscriptionId: filtered.subscriptionId,
          agentId: agent.id,
        }),
      ]),
    );
    await plugin.dispose();
    const before = pluginUpdates.length;
    await admin.updateAgent(agent.id, { name: "Still observed" });
    await expect
      .poll(() => appUpdates)
      .toEqual(
        expect.arrayContaining([
          expect.objectContaining({ agent: expect.objectContaining({ title: "Still observed" }) }),
        ]),
      );
    expect(pluginUpdates).toHaveLength(before);
  } finally {
    await client.close();
    await admin.close();
    await daemon.close();
  }
});

test("public SDK scope cancellation during bootstrap releases the returned ID", async () => {
  const daemon = await createTestPaseoDaemon({ mcpEnabled: false });
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
  const lifetime = new AbortController();
  const api = createPaseoApi(client, { signal: lifetime.signal });
  try {
    await client.connect();
    const listing = api.agents.list({ subscribe: {} });
    lifetime.abort();
    await expect(listing).rejects.toThrow("released");
    await api.dispose();
    const { diagnostic } = await client.collectDiagnostics();
    expect(diagnostic).toContain("Source registrations: 0");
    expect(diagnostic).toContain("Producer listeners: 0");
    await expect(api.agents.list({ subscribe: {} })).rejects.toThrow("disposed");
  } finally {
    await client.close();
    await daemon.close();
  }
});

test("a restored public SDK timeline leaves missed history to the consumer", async () => {
  const daemon = await createTestPaseoDaemon({ mcpEnabled: false });
  const sockets: WebSocket[] = [];
  const makeClient = (observer: boolean) =>
    new PublicDaemonClient({
      url: `ws://127.0.0.1:${daemon.port}/ws`,
      clientId: observer ? "timeline-observer" : "timeline-actor",
      appVersion: "0.8.0",
      reconnect: { enabled: false },
      webSocketFactory: (url) => {
        const socket = new WebSocket(url);
        if (observer) {
          sockets.push(socket);
        }
        return socket as unknown as WebSocketLike;
      },
    });
  const observer = makeClient(true);
  const actor = makeClient(false);
  const api = createPaseoApi(observer);
  const received: unknown[] = [];
  try {
    await actor.connect();
    await observer.connect();
    const agent = await actor.createAgent({
      provider: "codex",
      cwd: daemon.staticDir,
      title: "Reconnect review",
    });
    const handle = api.agents.ref(agent.id);
    const subscription = handle.timeline.subscribe((event) => received.push(event));
    await subscription.ready;
    await actor.sendMessage(agent.id, "before-outage");
    await actor.waitForFinish(agent.id);
    await expect.poll(() => JSON.stringify(received)).toContain("before-outage");
    const cached = await handle.timeline.refetch();
    expect(cached.endCursor).not.toBeNull();
    const oldId = subscription.subscriptionId;
    sockets[0]!.terminate();
    await expect.poll(() => observer.getConnectionState().status).not.toBe("connected");
    await actor.sendMessage(agent.id, "during-outage");
    await actor.waitForFinish(agent.id);
    await observer.connect();
    await expect
      .poll(() => subscription.subscriptionId)
      .toSatisfy((id: unknown) => typeof id === "string" && id !== oldId);
    await expect.poll(() => JSON.stringify(received)).toContain("subscription_restored");
    expect(JSON.stringify(received)).not.toContain("during-outage");
    await actor.sendMessage(agent.id, "after-outage");
    await actor.waitForFinish(agent.id);
    await expect.poll(() => JSON.stringify(received)).toContain("after-outage");
    const history = await handle.timeline.refetch({
      direction: "after",
      cursor: cached.endCursor!,
      projection: "projected",
    });
    expect(JSON.stringify(history)).toContain("during-outage");
    expect(JSON.stringify(received)).not.toContain("during-outage");
  } finally {
    await api.dispose();
    await observer.close();
    await actor.close();
    await daemon.close();
  }
});

test("VCS owned subscriptions restore fresh state after reconnect and release independently", async () => {
  const { mkdir, writeFile } = await import("node:fs/promises");
  const path = await import("node:path");
  const { execCommand } = await import("@getpaseo/plugin/server");
  const { BuiltinPluginLoader } = await import("./plugins/builtin/index.js");
  const daemon = await createTestPaseoDaemon({
    mcpEnabled: false,
    builtinPlugins: new BuiltinPluginLoader(undefined, ["jj-vcs"]),
  });
  const sockets: WebSocket[] = [];
  const client = new PublicDaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    clientId: "vcs-observer",
    appVersion: "0.15.2",
    reconnect: { enabled: false },
    webSocketFactory: (url) => {
      const socket = new WebSocket(url);
      sockets.push(socket);
      return socket as unknown as WebSocketLike;
    },
  });
  try {
    const cwd = path.join(daemon.staticDir, "repository");
    await mkdir(cwd);
    await execCommand("jj", ["git", "init", cwd]);
    await writeFile(path.join(cwd, "file.txt"), "initial\n");
    await client.connect();
    const created = await client.createWorkspace({ source: { kind: "directory", path: cwd } });
    if (!created.workspace) throw new Error(created.error ?? "Missing workspace");
    const api = createPaseoApi(client);
    const plugin = createPaseoApi(client);
    const vcs = api.workspaces.ref(created.workspace.id).vcs;
    const snapshots: string[] = [];
    const errors: string[] = [];
    const subscription = vcs.observeSnapshot("jj");
    subscription.subscribe({
      snapshot: (value) => {
        if (value.result) snapshots.push(value.result.version);
      },
      update: (message) => {
        if (message.type === "vcs.snapshot.changed") {
          if (message.payload.result) snapshots.push(message.payload.result.version);
          if (message.payload.error) errors.push(message.payload.error.message);
        }
      },
    });
    const initial = await subscription.ready;
    const second = plugin.workspaces.ref(created.workspace.id).vcs.observeSnapshot("jj");
    const shared = await second.ready;
    expect(shared.result?.version).toBe(initial.result?.version);
    await plugin.dispose();
    expect(second.subscriptionId).toBeNull();
    await writeFile(path.join(cwd, "file.txt"), "changed\n");
    await expect.poll(() => snapshots.at(-1), { timeout: 10000 }).not.toBe(initial.result?.version);
    const id = subscription.subscriptionId;
    sockets[0]!.terminate();
    await expect.poll(() => client.getConnectionState().status).not.toBe("connected");
    await writeFile(path.join(cwd, "file.txt"), "changed while disconnected\n");
    const previous = snapshots.at(-1);
    await client.connect();
    await expect
      .poll(() => subscription.subscriptionId)
      .toSatisfy((value: unknown) => typeof value === "string" && value !== id);
    await expect.poll(() => snapshots.at(-1), { timeout: 10000 }).not.toBe(previous);
    await client.archiveWorkspace(created.workspace.id);
    await expect
      .poll(() => errors)
      .toContain("Workspace or VCS selection changed; reopen observation");
    await api.dispose();
    expect(subscription.subscriptionId).toBeNull();
  } finally {
    await client.close();
    await daemon.close();
  }
});

test.each([
  "edit",
  "rebase",
  "abandon",
  "squash",
  "split",
  "bookmark-create",
  "bookmark-set",
  "bookmark-delete",
  "bookmark-track",
])(
  "jj %s survives a lost action reply and reconnect without repeating the mutation",
  async (action) => {
    const { mkdir, writeFile } = await import("node:fs/promises");
    const path = await import("node:path");
    const { execCommand } = await import("@getpaseo/plugin/server");
    const { BuiltinPluginLoader } = await import("./plugins/builtin/index.js");
    const daemon = await createTestPaseoDaemon({
      mcpEnabled: false,
      builtinPlugins: new BuiltinPluginLoader(undefined, ["jj-vcs"]),
    });
    let dropReply = true;
    class LoseActionReplySocket extends WebSocket {
      override emit(event: string | symbol, ...args: unknown[]): boolean {
        const data = args[0];
        if (
          dropReply &&
          event === "message" &&
          Buffer.isBuffer(data) &&
          data.toString().includes('"vcs.actions.execute.response"')
        ) {
          dropReply = false;
          this.terminate();
          return true;
        }
        return super.emit(event, ...args);
      }
    }
    const client = new PublicDaemonClient({
      url: `ws://127.0.0.1:${daemon.port}/ws`,
      appVersion: "0.15.2",
      clientId: `jj-lost-reply-${action}`,
      reconnect: { enabled: false },
      webSocketFactory: (url) => new LoseActionReplySocket(url) as unknown as WebSocketLike,
    });
    try {
      const cwd = path.join(daemon.staticDir, "repository");
      await mkdir(cwd);
      const jj = async (...args: string[]) =>
        (await execCommand("jj", args, { cwd })).stdout.trim();
      await jj("git", "init");
      await writeFile(path.join(cwd, "base.txt"), "base\n");
      await jj("describe", "-m", "Base");
      const base = await jj("log", "--no-graph", "-r", "@", "-T", "commit_id");
      await jj("new", "-m", "Source");
      await writeFile(path.join(cwd, "source.txt"), "source\n");
      await writeFile(path.join(cwd, "leftover.txt"), "leftover\n");
      const source = await jj("log", "--no-graph", "-r", "@", "-T", "commit_id");
      await jj("new", "-m", "Child");
      await writeFile(path.join(cwd, "child.txt"), "child\n");
      await jj("new", base, "-m", "Destination");
      const destination = await jj("log", "--no-graph", "-r", "@", "-T", "commit_id");
      const name = "topic@review";
      if (action === "bookmark-set" || action === "bookmark-delete")
        await jj("bookmark", "create", JSON.stringify(name), "-r", base);
      if (action === "bookmark-track") {
        const remote = path.join(daemon.staticDir, "remote.git");
        await execCommand("git", ["init", "--bare", remote]);
        const backend = await jj("git", "root");
        await execCommand("git", [
          "--git-dir",
          backend,
          "push",
          remote,
          `${source}:refs/heads/${name}`,
        ]);
        await jj("git", "remote", "add", "origin", remote);
        await jj("--config", "git.auto-local-bookmark=false", "git", "fetch", "--remote", "origin");
      }
      await client.connect();
      const created = await client.createWorkspace({ source: { kind: "directory", path: cwd } });
      if (!created.workspace) throw new Error(created.error ?? "Missing workspace");
      const api = createPaseoApi(client);
      const vcs = api.workspaces.ref(created.workspace.id).vcs;
      const before = await vcs.snapshot("jj");
      const request = {
        operationId: "lost-reply",
        version: before.version,
        action,
        input: {
          revision: source,
          destination: action === "squash" ? base : destination,
          files: ["source.txt"],
          message: "Selected files",
          name,
          remote: "origin",
        },
      };
      await expect(vcs.execute("jj", request)).rejects.toThrow();
      expect(dropReply).toBe(false);
      await client.connect();
      await expect
        .poll(async () => (await vcs.operation("jj", request.operationId)).status, {
          timeout: 10_000,
        })
        .toBe("succeeded");
      const after = await vcs.snapshot("jj");
      expect(after.version).not.toBe(before.version);
      expect(await vcs.execute("jj", request)).toMatchObject({
        status: "succeeded",
        id: request.operationId,
      });
      expect((await vcs.snapshot("jj")).version).toBe(after.version);
      await api.dispose();
    } finally {
      await client.close();
      await daemon.close();
    }
  },
);
