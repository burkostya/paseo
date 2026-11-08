import pino from "pino";
import { FileBackedWorkspaceRegistry } from "../../workspace-registry.js";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, cp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, test } from "vitest";
import { compilePlugin } from "../compiler.js";
import { readPluginManifest } from "../manifest.js";
import { DaemonClient } from "../../test-utils/daemon-client.js";
import { createTestPaseoDaemon } from "../../test-utils/paseo-daemon.js";
import { BuiltinPluginLoader, builtinPlugins, resolveBuiltinPluginsRoot } from "./index.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(root: string, id: string, client = false): Promise<string> {
  const directory = path.join(root, id);
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, "paseo-plugin.json"),
    JSON.stringify({ id, requirements: { paseo: ">=0.9.2" } }),
  );
  await writeFile(
    path.join(directory, "index.server.ts"),
    "export default function contribute() { return () => {}; }",
  );
  if (client) {
    await writeFile(
      path.join(directory, "index.client.tsx"),
      "export default function contribute() { const marker = 'builtin-client-marker'; void marker; return () => {}; }",
    );
  }
  return directory;
}

test("listed built-ins resolve to matching manifests and compile", async () => {
  const root = resolveBuiltinPluginsRoot();
  for (const id of builtinPlugins) {
    const directory = path.join(root, id);
    expect((await readPluginManifest(directory)).id).toBe(id);
    const findEntry = async (names: string[]) => {
      for (const name of names) {
        const entry = path.join(directory, name);
        if ((await stat(entry).catch(() => null))?.isFile()) return entry;
      }
      return null;
    };
    const bundles = await compilePlugin({
      server: await findEntry(["index.server.ts", "index.server.tsx"]),
      client: await findEntry(["index.client.ts", "index.client.tsx"]),
    });
    expect(bundles.serverBundle).toBeTruthy();
  }
});

test("listed client bundle is published while plugins are disabled; unlisted directory is inert", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "paseo-builtin-fixture-"));
  roots.push(root);
  await fixture(root, "listed", true);
  await fixture(root, "unlisted", true);
  const daemon = await createTestPaseoDaemon({
    daemonVersion: "0.9.2",
    pluginsEnabled: false,
    builtinPlugins: new BuiltinPluginLoader(root, ["listed"]),
  });
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws`, appVersion: "0.9.2" });
  try {
    await client.connect();
    expect(await client.listPlugins()).toEqual([]);
    const catalog = await client.getPluginCatalog();
    expect(catalog.map(({ id }) => id)).toEqual(["listed"]);
    expect(catalog[0]?.clientBundle).toContain("builtin-client-marker");
  } finally {
    await client.close();
    await daemon.close();
  }
}, 60_000);

test("a repeated catalog fetch leaves out the client bundle the client already holds", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "paseo-builtin-catalog-cache-"));
  roots.push(root);
  const directory = await fixture(root, "large", true);
  // About the size of a real plugin client bundle.
  await writeFile(
    path.join(directory, "index.client.tsx"),
    `const payload = ${JSON.stringify("x".repeat(1_000_000))};
export default function contribute() { void payload; return () => {}; }`,
  );
  const daemon = await createTestPaseoDaemon({
    daemonVersion: "0.9.2",
    pluginsEnabled: false,
    builtinPlugins: new BuiltinPluginLoader(root, ["large"]),
  });
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws`, appVersion: "0.9.2" });
  const responseBytes: number[] = [];
  const unsubscribe = client.subscribeRawMessages((message) => {
    if (message.type === "plugin.catalog.get.response") {
      responseBytes.push(JSON.stringify(message).length);
    }
  });
  try {
    await client.connect();
    const first = await client.getPluginCatalog();
    const second = await client.getPluginCatalog();

    expect(second).toEqual(first);
    expect(second[0]?.clientBundle).toContain("x".repeat(1_000_000));
    expect(responseBytes).toHaveLength(2);
    expect(responseBytes[0]).toBeGreaterThan(1_000_000);
    expect(responseBytes[1]).toBeLessThan(500);
  } finally {
    unsubscribe();
    await client.close();
    await daemon.close();
  }
}, 60_000);

test("directory, Git, and npm installs reject a built-in ID", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "paseo-builtin-install-"));
  roots.push(root);
  const directory = await fixture(root, "reserved");
  const gitDirectory = await fixture(root, "git-source");
  await writeFile(
    path.join(gitDirectory, "paseo-plugin.json"),
    JSON.stringify({ id: "reserved", requirements: { paseo: ">=0.9.2" } }),
  );
  execFileSync("git", ["init", "-q", gitDirectory]);
  execFileSync("git", [
    "-C",
    gitDirectory,
    "-c",
    "user.name=Paseo Tests",
    "-c",
    "user.email=paseo@example.test",
    "add",
    ".",
  ]);
  execFileSync("git", [
    "-C",
    gitDirectory,
    "-c",
    "user.name=Paseo Tests",
    "-c",
    "user.email=paseo@example.test",
    "commit",
    "-qm",
    "fixture",
  ]);
  const daemon = await createTestPaseoDaemon({
    daemonVersion: "0.9.2",
    pluginsEnabled: false,
    builtinPlugins: new BuiltinPluginLoader(root, ["reserved"]),
  });
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws`, appVersion: "0.9.2" });
  try {
    await client.connect();
    await expect(client.installDirectoryPlugin(directory)).rejects.toThrow(
      /reserved for a built-in/,
    );
    await expect(
      client.installPluginSource({ source: pathToFileURL(gitDirectory).href }),
    ).rejects.toThrow(/reserved for a built-in/);
    await expect(
      client.installPluginSource({ source: "npm:unused-fixture", id: "reserved" }),
    ).rejects.toThrow(/reserved for a built-in/);
    expect(await client.listPlugins()).toEqual([]);
  } finally {
    await client.close();
    await daemon.close();
  }
}, 60_000);

test("workspace VCS SDK reads and executes jj operations through the daemon", async () => {
  const { createPaseoApi, VcsRequestError } = await import("@getpaseo/client");
  const root = await mkdtemp(path.join(os.tmpdir(), "paseo-workspace-vcs-"));
  roots.push(root);
  const firstRoot = path.join(root, "first");
  const secondRoot = path.join(root, "second");
  const { execCommand } = await import("@getpaseo/plugin/server");
  await execCommand("jj", ["git", "init", firstRoot]);
  await execCommand("jj", ["git", "init", secondRoot]);
  await writeFile(path.join(firstRoot, "file.txt"), "first workspace\n");
  await writeFile(path.join(secondRoot, "file.txt"), "second workspace\n");
  const daemon = await createTestPaseoDaemon({
    daemonVersion: "0.15.2",
    pluginsEnabled: false,
    builtinPlugins: new BuiltinPluginLoader(resolveBuiltinPluginsRoot(), ["git-vcs", "jj-vcs"]),
  });
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    appVersion: "0.15.2",
  });
  const api = createPaseoApi(client);
  try {
    await client.connect();
    const first = await api.workspaces.open(firstRoot);
    const second = await api.workspaces.open(secondRoot);
    expect(await first.vcs.providers()).toEqual([
      { id: "git", pluginId: "git-vcs", label: "Git" },
      { id: "jj", pluginId: "jj-vcs", label: "Jujutsu", detectionPriority: 10 },
    ]);
    expect(await first.vcs.detect("jj")).toMatchObject({
      status: "available",
      binding: { cwd: firstRoot },
    });
    expect(await api.projects.vcs.get(first.projectId!)).toEqual({
      projectId: first.projectId,
      providerId: "jj",
    });
    const snapshot = await first.vcs.snapshot();
    expect(snapshot.files).toEqual([{ path: "file.txt", status: "added", conflict: false }]);
    expect(await first.vcs.diff("jj", { kind: "working-copy" })).toMatchObject({
      patch: expect.stringContaining("+first workspace"),
    });
    expect(await first.vcs.history("jj", { limit: 1 })).toMatchObject({
      revisions: [{ id: snapshot.current!.id }],
      cursor: expect.any(String),
    });
    const nextPage = await first.vcs.history("jj", {
      limit: 1,
      cursor: (await first.vcs.history("jj", { limit: 1 })).cursor,
    });
    expect(nextPage.revisions[0]!.id).toBe(snapshot.current!.parents[0]);
    const operationId = "same-id";
    const options = {
      operationId,
      version: snapshot.version,
      action: "describe",
      input: { revision: snapshot.current!.id, message: "First description" },
    };
    await first.vcs.execute("jj", options);
    const secondSnapshot = await second.vcs.snapshot("jj");
    await second.vcs.execute("jj", {
      ...options,
      version: secondSnapshot.version,
      input: { revision: secondSnapshot.current!.id, message: "Second description" },
    });
    await expect
      .poll(() => first.vcs.operation("jj", operationId))
      .toMatchObject({ id: operationId, status: "succeeded" });
    await expect
      .poll(() => second.vcs.operation("jj", operationId))
      .toMatchObject({ id: operationId, status: "succeeded" });
    expect((await first.vcs.snapshot("jj")).current!.description).toBe("First description\n");
    expect((await second.vcs.snapshot("jj")).current!.description).toBe("Second description\n");
    expect(await first.vcs.execute("jj", options)).toMatchObject({
      id: operationId,
      status: "succeeded",
    });
    await first.vcs.execute("jj", { ...options, operationId: "outdated" });
    await expect
      .poll(() => first.vcs.operation("jj", "outdated"))
      .toMatchObject({ status: "failed", error: { code: "outdated" } });
    expect(await first.vcs.operation("jj", "never-submitted")).toEqual({
      id: "never-submitted",
      status: "unknown",
    });
    await expect(first.vcs.snapshot("missing")).rejects.toBeInstanceOf(VcsRequestError);
    await expect(api.workspaces.ref("missing").vcs.snapshot("jj")).rejects.toMatchObject({
      problem: { code: "unavailable" },
    });
    // Reconnect uses the same workspace identity and never re-submits a mutation.
    const reconnected = new DaemonClient({
      url: `ws://127.0.0.1:${daemon.port}/ws`,
      appVersion: "0.15.2",
    });
    try {
      await reconnected.connect();
      const ref = createPaseoApi(reconnected).workspaces.ref(first.id);
      expect(await ref.vcs.operation("jj", operationId)).toMatchObject({ status: "succeeded" });
    } finally {
      await reconnected.close();
    }
    await first.archive();
    await expect(
      first.vcs.execute("jj", { ...options, operationId: "archived" }),
    ).rejects.toMatchObject({ problem: { code: "unavailable" } });
    expect(await first.vcs.operation("jj", operationId)).toMatchObject({ status: "succeeded" });
  } finally {
    await api.dispose();
    await client.close();
    await daemon.close();
  }
}, 60_000);

test("VCS project selection survives daemon restart and blocks legacy Git mutation", async () => {
  const { execCommand } = await import("@getpaseo/plugin/server");
  const { createPaseoApi } = await import("@getpaseo/client");
  const root = await mkdtemp(path.join(os.tmpdir(), "paseo-vcs-selection-"));
  roots.push(root);
  const cwd = path.join(root, "colocated");
  await execCommand("jj", ["git", "init", "--colocate", cwd]);
  const options = {
    daemonVersion: "0.15.2",
    paseoHomeRoot: path.join(root, "state"),
    cleanup: false,
    pluginsEnabled: false,
    builtinPlugins: new BuiltinPluginLoader(resolveBuiltinPluginsRoot(), ["git-vcs", "jj-vcs"]),
  };
  const daemon = await createTestPaseoDaemon(options);
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    appVersion: "0.15.2",
  });
  let workspaceId: string;
  let projectId: string;
  try {
    await client.connect();
    const api = createPaseoApi(client);
    const workspace = await api.workspaces.open(cwd);
    workspaceId = workspace.id;
    projectId = workspace.projectId!;
    expect(await api.projects.vcs.get(projectId)).toEqual({ projectId, providerId: "jj" });
    expect(workspace.current()).toMatchObject({
      workspaceKind: "directory",
      projectKind: "non_git",
      vcsProviderId: "jj",
      project: { checkout: { isGit: false } },
    });
    expect((await workspace.vcs.snapshot()).binding.providerId).toBe("jj");
    await expect(
      client.checkoutCommit(cwd, { message: "Must not run", addAll: true }),
    ).rejects.toThrow("use its VCS actions");
    await expect(api.projects.vcs.select(projectId, "missing")).rejects.toMatchObject({
      problem: { code: "unavailable" },
    });
    expect(await api.projects.vcs.get(projectId)).toEqual({ projectId, providerId: "jj" });
    await api.projects.vcs.select(projectId, "git");
    expect((await workspace.vcs.snapshot()).binding.providerId).toBe("git");
    await expect(workspace.vcs.snapshot("jj")).rejects.toMatchObject({
      problem: { code: "outdated" },
    });
    await api.dispose();
  } finally {
    await client.close();
    await daemon.close();
  }
  const restarted = await createTestPaseoDaemon(options);
  const next = new DaemonClient({
    url: `ws://127.0.0.1:${restarted.port}/ws`,
    appVersion: "0.15.2",
  });
  try {
    await next.connect();
    const api = createPaseoApi(next);
    expect(await api.projects.vcs.get(projectId!)).toEqual({
      projectId: projectId!,
      providerId: "git",
    });
    const workspace = api.workspaces.ref(workspaceId!);
    expect((await workspace.vcs.snapshot()).binding.providerId).toBe("git");
    await api.projects.vcs.select(projectId!, "jj");
    expect((await workspace.vcs.snapshot()).binding.providerId).toBe("jj");
    await api.dispose();
  } finally {
    await next.close();
    await restarted.close();
  }
}, 60_000);

test.each(["git", "jj", "external-jj"])(
  "VCS archive/recovery keeps shared copies and restores exact cwd after daemon restart for %s",
  async (mode) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paseo-vcs-archive-"));
    roots.push(root);
    const source = path.join(root, "repo");
    const run = (command: string, args: string[], cwd = source) =>
      execFileSync(command, args, { cwd, stdio: "pipe" });
    await mkdir(path.join(source, "sub"), { recursive: true });
    run("git", ["init", "-b", "main"]);
    run("git", ["config", "user.name", "Test"]);
    run("git", ["config", "user.email", "test@example.test"]);
    await writeFile(path.join(source, "sub", "file.txt"), "initial\n");
    await writeFile(
      path.join(source, "sub", "paseo.json"),
      JSON.stringify({
        worktree: {
          teardown: [
            "node -e \"require('fs').appendFileSync(process.env.PASEO_SOURCE_CHECKOUT_PATH + '/teardown.log', process.cwd() + '\\n')\"",
          ],
        },
      }),
    );
    run("git", ["add", "."]);
    run("git", ["-c", "commit.gpgsign=false", "commit", "-m", "initial"]);
    if (mode !== "git") run("jj", ["git", "init", "--colocate", source]);
    const external = path.join(root, "external-jj");
    if (mode === "external-jj") {
      await cp(path.join(resolveBuiltinPluginsRoot(), "jj-vcs"), external, { recursive: true });
      await writeFile(
        path.join(external, "paseo-plugin.json"),
        JSON.stringify({ id: "external-jj", requirements: { paseo: ">=0.15.2" } }),
      );
    }
    const registryPath = path.join(root, "state", ".paseo", "projects", "workspaces.json");
    const removalFailure = path.join(root, "fail-remove");
    const restoreFailure = path.join(root, "fail-restore");
    const holdRemoval = path.join(root, "hold-removal");
    const removalStarted = path.join(root, "removal-started");
    const importStarted = path.join(root, "import-started");
    if (mode === "external-jj")
      await writeFile(
        path.join(external, "index.server.ts"),
        `
import { jjProvider } from './server/provider.js';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { VcsError } from '@getpaseo/plugin/server/vcs';
import { setTimeout as delay } from 'node:timers/promises';
export default function contribute(server) {
  const copies = jjProvider.workingCopies;
  const recovery = copies.recovery;
  server.addHook('workspace.create.before', async ({ request }) => {
    if (request.source.kind === 'directory' && await stat(${JSON.stringify(holdRemoval)}).catch(() => null)) await writeFile(${JSON.stringify(importStarted)}, 'importing');
  });
  server.registerVcsProvider({ ...jjProvider, workingCopies: { ...copies, recovery: {
    ...recovery,
    async remove(record, context) {
      const entries = JSON.parse(await readFile(${JSON.stringify(registryPath)}, 'utf8'));
      if (!entries.some(entry => entry.vcsWorkingCopy?.binding.root === record.binding.root && JSON.stringify(entry.vcsWorkingCopy.recovery) === JSON.stringify(record.recovery))) throw new Error('Recovery data was not persisted before removal');
      if (await stat(${JSON.stringify(removalFailure)}).catch(() => null)) throw new VcsError({ code: 'provider', message: 'simulated removal failure' });
      if (await stat(${JSON.stringify(holdRemoval)}).catch(() => null)) {
        await writeFile(${JSON.stringify(removalStarted)}, 'removing');
        while (await stat(${JSON.stringify(holdRemoval)}).catch(() => null)) { context.signal.throwIfAborted(); await delay(10); }
      }
      return recovery.remove(record, context);
    },
    async restore(record, context) {
      if (await stat(${JSON.stringify(restoreFailure)}).catch(() => null)) {
        await mkdir(record.binding.root, { recursive: true });
        await writeFile(record.binding.root + '/partial.txt', 'partial restore retained');
        throw new VcsError({ code: 'provider', message: 'simulated restore failure' });
      }
      return recovery.restore(record, context);
    },
  } } });
  return () => {};
}
`,
      );
    const options: Parameters<typeof createTestPaseoDaemon>[0] = {
      pluginsEnabled: mode === "external-jj",
      plugins:
        mode === "external-jj"
          ? { "external-jj": { source: "directory", path: external, enabled: true } }
          : undefined,
      paseoHomeRoot: path.join(root, "state"),
      cleanup: false,
      builtinPlugins: new BuiltinPluginLoader(
        resolveBuiltinPluginsRoot(),
        mode === "external-jj" ? ["git-vcs"] : ["git-vcs", "jj-vcs"],
      ),
    };
    let daemon = await createTestPaseoDaemon(options);
    let client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
    const registryFile = path.join(daemon.paseoHome, "projects", "workspaces.json");
    async function stored(id: string) {
      const registry = new FileBackedWorkspaceRegistry(registryFile, pino({ level: "silent" }));
      await registry.initialize();
      const record = await registry.get(id);
      if (!record) throw new Error("Missing persisted workspace");
      return record;
    }
    async function workingCopy(id: string) {
      const workspace = await stored(id);
      if (!workspace.vcsWorkingCopy) throw new Error("Missing working-copy record");
      return workspace.vcsWorkingCopy;
    }
    try {
      await client.connect();
      if (mode === "external-jj")
        expect(
          (await client.listPlugins()).find((plugin) => plugin.id === "external-jj")?.status,
        ).toBe("running");
      const opened = await client.createWorkspace({
        source: { kind: "directory", path: path.join(source, "sub") },
      });
      expect(opened.error).toBeNull();
      const projectId = opened.workspace!.projectId;
      if (!projectId) throw new Error("Missing project");
      const created = await client.createWorkspace({ source: { kind: "working-copy", projectId } });
      expect(created.error).toBeNull();
      const workspace = created.workspace!;
      const cwd = workspace.workspaceDirectory!;
      const copyRoot = path.dirname(cwd);
      await expect
        .poll(async () => (await client.fetchWorkspaceSetupStatus(workspace.id)).snapshot)
        .toMatchObject({ status: "completed" });
      await writeFile(path.join(cwd, "file.txt"), "uncommitted preserved\n");
      const imported = await client.createWorkspace({ source: { kind: "directory", path: cwd } });
      expect(imported.error).toBeNull();
      const alias = imported.workspace!;
      expect(alias.projectId).not.toBe(workspace.projectId);
      expect((await client.archiveWorkspace(workspace.id)).error).toBeNull();
      expect((await stat(cwd)).isDirectory()).toBe(true);
      expect((await workingCopy(alias.id)).owned).toBe(true);
      if (mode === "external-jj") {
        await writeFile(removalFailure, "fail");
        const failed = await client.archiveWorkspace(alias.id);
        expect(failed.error).toBeNull();
        expect(failed.warning).toContain("simulated removal failure");
        expect(await workingCopy(alias.id)).toMatchObject({
          recoveryError: { message: "simulated removal failure" },
          recovery: { version: 1 },
        });
        expect((await stat(cwd)).isDirectory()).toBe(true);
        await client.restoreWorkspace(alias.id);
        expect((await workingCopy(alias.id)).recovery).toBeUndefined();
        await rm(removalFailure);
      }
      async function archiveLastReference() {
        if (mode !== "external-jj") return client.archiveWorkspace(alias.id);
        await writeFile(holdRemoval, "hold");
        const archiving = client.archiveWorkspace(alias.id);
        void archiving.catch(() => undefined);
        await expect.poll(() => readFile(removalStarted, "utf8").catch(() => "")).toBe("removing");
        const importedId = "wks_9999999999999999";
        const importing = client.createWorkspace({
          workspaceId: importedId,
          source: { kind: "directory", path: cwd, projectId },
        });
        void importing.catch(() => undefined);
        await expect.poll(() => readFile(importStarted, "utf8").catch(() => "")).toBe("importing");
        const registry = new FileBackedWorkspaceRegistry(registryFile, pino({ level: "silent" }));
        await registry.initialize();
        expect(await registry.get(importedId)).toBeNull();
        await rm(holdRemoval);
        const result = await archiving;
        const rejected = await importing;
        expect(rejected.error).not.toBeNull();
        expect(rejected.workspace).toBeNull();
        const after = new FileBackedWorkspaceRegistry(registryFile, pino({ level: "silent" }));
        await after.initialize();
        expect(await after.get(importedId)).toBeNull();
        return result;
      }
      const archived = await archiveLastReference();
      expect(archived.error).toBeNull();
      expect(archived.warning).toBeUndefined();
      await expect(stat(copyRoot)).rejects.toMatchObject({ code: "ENOENT" });
      const expectedTeardown = `${cwd}\n`.repeat(mode === "external-jj" ? 3 : 2);
      expect(await readFile(path.join(source, "teardown.log"), "utf8")).toBe(expectedTeardown);
      const archivedRecord = await stored(alias.id);
      expect(archivedRecord.cwd).toBe(cwd);
      expect((await workingCopy(alias.id)).recovery?.version).toBe(1);
      expect((await workingCopy(workspace.id)).recovery).toEqual(
        (await workingCopy(alias.id)).recovery,
      );
      await client.close();
      await daemon.close();
      daemon = await createTestPaseoDaemon(options);
      client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
      await client.connect();
      const inspection = await client.inspectWorkspaceRecovery(alias.id);
      if (inspection.kind === "unavailable") throw new Error(inspection.message);
      expect(inspection).toMatchObject({ kind: "recoverable", action: "restore" });
      if (mode === "external-jj") {
        await writeFile(restoreFailure, "fail");
        await expect(client.restoreWorkspace(alias.id)).rejects.toThrow(
          "simulated restore failure",
        );
        const partial = await stored(alias.id);
        expect(partial.archivedAt).not.toBeNull();
        expect(partial.vcsWorkingCopy).toMatchObject({
          state: "restoring",
          recovery: { version: 1 },
          recoveryError: { message: "simulated restore failure" },
        });
        expect(await readFile(path.join(copyRoot, "partial.txt"), "utf8")).toBe(
          "partial restore retained",
        );
        await rename(copyRoot, path.join(root, "retained-partial"));
        await rm(restoreFailure);
      }
      await client.restoreWorkspace(alias.id);
      expect(await readFile(path.join(cwd, "file.txt"), "utf8")).toBe("uncommitted preserved\n");
      expect((await stored(alias.id)).archivedAt).toBeNull();
      expect((await workingCopy(alias.id)).recovery).toBeUndefined();
      expect((await workingCopy(workspace.id)).recovery).toBeUndefined();
      expect(await readFile(path.join(source, "teardown.log"), "utf8")).toBe(expectedTeardown);
    } finally {
      await client.close();
      await daemon.close();
    }
  },
  60_000,
);
