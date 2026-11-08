import { expect, test } from "../support/fixtures";
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildNewWorkspaceRoute } from "../../src/utils/host-routes";
import { gotoAppShell } from "../support/helpers/app";
import {
  archiveLocalWorkspaceFromDaemon,
  archiveWorkspaceFromDaemon,
  assertNewWorkspaceSidebarAndHeader,
  connectNewWorkspaceDaemonClient,
  expectWorkspaceIsolationSelected,
  openNewWorkspaceComposer,
  openProjectViaDaemon,
  selectWorkspaceIsolation,
  loadSessionMessageReaders,
} from "../support/helpers/new-workspace";
import { daemonWsRoutePattern } from "../support/helpers/daemon-port";
import { expectNoTruncation } from "../support/helpers/no-truncation";
import { createTempGitRepo } from "../support/helpers/workspace";
import { getServerId } from "../support/helpers/server-id";
import { waitForSidebarHydration } from "../support/helpers/workspace-ui";

// Regression for "the local / worktree selection in the new workspace is not
// remembered." The isolation choice persists in the create-form preferences
// (FormPreferences.isolation), so it must survive the create→reopen remount:
// creating a worktree workspace navigates away from /new and unmounts it, and
// reopening New Workspace has to still show "New worktree".
test.describe("New workspace isolation memory", () => {
  let client: Awaited<ReturnType<typeof connectNewWorkspaceDaemonClient>>;
  const localWorkspaceIds = new Set<string>();
  const createdWorktreeDirectories = new Set<string>();

  test.describe.configure({ timeout: 240_000 });

  test.beforeEach(async () => {
    client = await connectNewWorkspaceDaemonClient();
  });

  test.afterEach(async () => {
    if (client) {
      for (const workspaceDirectory of createdWorktreeDirectories) {
        await archiveWorkspaceFromDaemon(client, workspaceDirectory).catch(() => undefined);
      }
      for (const workspaceId of localWorkspaceIds) {
        await archiveLocalWorkspaceFromDaemon(client, workspaceId).catch(() => undefined);
      }
    }
    createdWorktreeDirectories.clear();
    localWorkspaceIds.clear();
    await client?.close().catch(() => undefined);
  });

  test("remembers the worktree isolation choice after creating a workspace", async ({ page }) => {
    const serverId = getServerId();
    const tempRepo = await createTempGitRepo("isolation-memory-", { branches: ["main", "dev"] });

    try {
      const openedProject = await openProjectViaDaemon(client, tempRepo.path);
      localWorkspaceIds.add(openedProject.workspaceId);

      await gotoAppShell(page);
      await waitForSidebarHydration(page);

      // First visit: the screen opens on Local, switch it to New worktree and create.
      await openNewWorkspaceComposer(page, {
        projectKey: openedProject.projectKey,
        projectDisplayName: openedProject.projectDisplayName,
      });
      await expectWorkspaceIsolationSelected(page, "local");
      await page.getByTestId("workspace-create-isolation-trigger").click();
      const isolationPopup = page.getByTestId("combobox-desktop-container").last();
      await expect(isolationPopup).toBeVisible({ timeout: 30_000 });
      await expectNoTruncation(isolationPopup);
      await page.getByTestId("workspace-create-isolation-worktree").click();
      await expectWorkspaceIsolationSelected(page, "worktree");

      await page.getByTestId("git-project-source").getByRole("button").click();
      await page.getByTestId("new-workspace-ref-picker-branch-dev").click();

      const createButton = page
        .getByTestId("message-input-root")
        .getByRole("button", { name: "Create" });
      await expect(createButton).toBeVisible({ timeout: 30_000 });
      await createButton.click();

      const createdWorkspace = await assertNewWorkspaceSidebarAndHeader(page, {
        serverId,
        client,
        previousWorkspaceId: openedProject.workspaceId,
        projectDisplayName: openedProject.projectDisplayName,
      });
      createdWorktreeDirectories.add(createdWorkspace.workspaceDirectory);

      // Second visit (fresh mount of /new): the worktree choice must stick.
      await openNewWorkspaceComposer(page, {
        projectKey: openedProject.projectKey,
        projectDisplayName: openedProject.projectDisplayName,
      });
      await expectWorkspaceIsolationSelected(page, "worktree");
    } finally {
      await tempRepo.cleanup();
    }
  });
});

for (const width of [1400, 390]) {
  test(`New workspace creates a pinned jj working copy at width ${width} without an active workspace`, async ({
    page,
  }) => {
    const client = await connectNewWorkspaceDaemonClient();
    const repo = await createTempGitRepo("new-jj-copy-", {
      files: [{ path: "sub/file.txt", content: "Selected revision\n" }],
    });
    let projectId: string | undefined;
    try {
      execFileSync("jj", ["git", "init", "--colocate", repo.path], { stdio: "pipe" });
      const revision = execFileSync(
        "jj",
        ["log", "--ignore-working-copy", "--no-graph", "-r", "@-", "-T", "commit_id"],
        { cwd: repo.path, encoding: "utf8" },
      ).trim();
      const opened = await client.createWorkspace({
        source: { kind: "directory", path: path.join(repo.path, "sub") },
      });
      if (!opened.workspace) throw new Error(opened.error ?? "Missing workspace");
      projectId = opened.workspace.projectId;
      await client.archiveWorkspace(opened.workspace.id);
      const frames = await loadSessionMessageReaders();
      const requests: string[] = [];
      await page.routeWebSocket(daemonWsRoutePattern(), (browser) => {
        const server = browser.connectToServer();
        browser.onMessage((frame) => {
          const message = frames.client(frame);
          if (message) requests.push(message.type);
          server.send(frame);
        });
      });
      await page.setViewportSize({ width, height: 900 });
      await page.goto(
        buildNewWorkspaceRoute({
          serverId: getServerId(),
          projectId,
          sourceDirectory: path.join(repo.path, "sub"),
        }),
      );
      await selectWorkspaceIsolation(page, "worktree");
      await expect(page.getByTestId("workspace-create-isolation-trigger")).toContainText(
        "New working copy",
      );
      await page.getByTestId("jj-working-copy-name").fill("invalid/name");
      await page.getByTestId("workspace-create-submit").click();
      await expect(
        page
          .getByText("Use letters, digits, dots, underscores or hyphens for the workspace name.", {
            exact: true,
          })
          .first(),
      ).toBeVisible();
      expect(requests).not.toContain("workspace.create.request");
      await page.getByTestId("jj-working-copy-name").fill("from-new-workspace");
      await page.getByTestId("new-workspace-vcs-revision").click();
      await page.getByRole("button", { name: new RegExp(revision) }).click();
      expect(requests).toContain("vcs.project.history.list.request");
      expect(requests).not.toContain("branch_suggestions_request");
      expect(requests).not.toContain("checkout_status_request");
      await writeFile(path.join(repo.path, "sub/file.txt"), "Later contents\n");
      await page.getByTestId("workspace-create-submit").click();
      await expect(page).toHaveURL(/\/workspace\/wks_/);
      const copies = (await client.fetchWorkspaces()).entries.filter(
        (item) => item.projectId === projectId && item.id !== opened.workspace!.id,
      );
      expect(copies).toHaveLength(1);
      expect(copies[0]!.vcsProviderId).toBe("jj");
      expect(
        execFileSync("jj", ["workspace", "root", "--name", "from-new-workspace"], {
          cwd: repo.path,
          encoding: "utf8",
        }).trim(),
      ).toBe(path.dirname(copies[0]!.workspaceDirectory));
      expect(path.basename(copies[0]!.workspaceDirectory)).toBe("sub");
      expect(await readFile(path.join(copies[0]!.workspaceDirectory, "file.txt"), "utf8")).toBe(
        "Selected revision\n",
      );
    } finally {
      if (projectId) await client.removeProject(projectId);
      await client.close();
      await repo.cleanup();
    }
  });
}

for (const width of [1400, 390]) {
  test(`Git project source extension preserves upstream and validates fields at width ${width}`, async ({
    page,
  }) => {
    const client = await connectNewWorkspaceDaemonClient();
    const repo = await createTempGitRepo("git-source-extension-", {
      files: [{ path: "file.txt", content: "upstream\n" }],
    });
    let projectId: string | undefined;
    try {
      const git = (args: string[]) =>
        execFileSync("git", args, { cwd: repo.path, encoding: "utf8" }).trim();
      git(["clone", "--bare", repo.path, path.join(repo.path, ".remote.git")]);
      git(["remote", "add", "upstream", path.join(repo.path, ".remote.git")]);
      git(["fetch", "upstream"]);
      git(["branch", "--set-upstream-to", "upstream/main", "main"]);
      const upstream = git(["rev-parse", "HEAD"]);
      await writeFile(path.join(repo.path, "file.txt"), "local only\n");
      git(["add", "file.txt"]);
      git(["-c", "commit.gpgsign=false", "commit", "-m", "Unpublished"]);
      const opened = await client.createWorkspace({
        source: { kind: "directory", path: repo.path },
      });
      if (!opened.workspace) throw new Error(opened.error ?? "No workspace");
      projectId = opened.workspace.projectId;
      await client.archiveWorkspace(opened.workspace.id);
      const frames = await loadSessionMessageReaders();
      const requests: string[] = [];
      let forgeResponses = 0;
      const sourceRequests = new Set<string>();
      let injectedSourceError = false;
      let submittedSource: unknown;
      await page.routeWebSocket(daemonWsRoutePattern(), (browser) => {
        const server = browser.connectToServer();
        server.onMessage((frame) => {
          const message = frames.server(frame);
          if (
            message?.type === "vcs.project.working-copy.resolve-source.response" &&
            sourceRequests.has(message.payload.requestId) &&
            !injectedSourceError
          ) {
            injectedSourceError = true;
            browser.send(
              JSON.stringify({
                type: "session",
                message: {
                  type: "rpc_error",
                  payload: {
                    requestId: message.payload.requestId,
                    error: "Injected source resolution failure",
                  },
                },
              }),
            );
            return;
          }
          if (message?.type === "forge.search.response") {
            forgeResponses++;
            if (forgeResponses === 1) {
              browser.send(
                JSON.stringify({
                  type: "session",
                  message: {
                    ...message,
                    payload: { ...message.payload, error: "Injected forge search failure" },
                  },
                }),
              );
              return;
            }
          }
          browser.send(frame);
        });
        browser.onMessage((frame) => {
          const message = frames.client(frame);
          if (message) requests.push(message.type);
          if (message?.type === "vcs.project.working-copy.resolve-source.request")
            sourceRequests.add(message.requestId);
          if (message?.type === "workspace.create.request") submittedSource = message.source;
          server.send(frame);
        });
      });
      await page.setViewportSize({ width, height: 900 });
      await page.goto(
        buildNewWorkspaceRoute({ serverId: getServerId(), projectId, sourceDirectory: repo.path }),
      );
      await selectWorkspaceIsolation(page, "worktree");
      await expect(page.getByTestId("git-project-source")).toContainText("main (upstream)");
      await expect(
        page.getByText("Injected source resolution failure", { exact: true }),
      ).toBeVisible();
      await page.getByTestId("workspace-create-submit").click();
      expect(requests).not.toContain("workspace.create.request");
      await page.getByRole("button", { name: "Refresh source", exact: true }).click();
      await expect(
        page.getByText("Injected source resolution failure", { exact: true }),
      ).toHaveCount(0);
      await page.getByTestId("new-workspace-ref-picker-trigger").click();
      await expect.poll(() => forgeResponses).toBe(1);
      await page.getByTestId("new-workspace-ref-picker-branch-main (upstream)").click();
      await expect(page.getByText("Injected forge search failure", { exact: true })).toBeVisible();
      await page.getByTestId("new-workspace-ref-picker-trigger").click();
      await expect.poll(() => forgeResponses).toBe(2);
      await page.getByTestId("new-workspace-ref-picker-branch-main (upstream)").click();
      await expect(page.getByText("Injected forge search failure", { exact: true })).toHaveCount(0);
      await page.getByTestId("git-working-copy-branch").fill("../invalid");
      await expect(page.getByText("Enter a valid branch name.")).toBeVisible();
      await page.getByTestId("workspace-create-submit").click();
      expect(requests).not.toContain("workspace.create.request");
      await page.getByTestId("git-working-copy-branch").fill("main");
      await expect(
        page.getByText("This branch already exists. Choose a new branch name."),
      ).toBeVisible();
      await page.getByTestId("workspace-create-submit").click();
      expect(requests).not.toContain("workspace.create.request");
      await page.getByTestId("git-working-copy-branch").fill("feature/from-extension");
      await page.getByTestId("workspace-create-submit").click();
      await expect(page).toHaveURL(/\/workspace\/wks_/);
      const copies = (await client.fetchWorkspaces()).entries.filter(
        (item) => item.projectId === projectId && item.id !== opened.workspace!.id,
      );
      expect(copies).toHaveLength(1);
      expect(submittedSource).toMatchObject({
        kind: "working-copy",
        providerId: "git",
        revision: upstream,
        providerData: {
          version: 2,
          data: {
            branch: "feature/from-extension",
            source: { kind: "branch", ref: "refs/remotes/upstream/main" },
          },
        },
      });
      expect(copies[0]!.vcsProviderId).toBe("git");
      expect(sourceRequests.size).toBeGreaterThan(1);
      expect(requests).not.toContain("plugin.rpc.invoke.request");
      expect(
        execFileSync("git", ["rev-parse", "HEAD"], {
          cwd: copies[0]!.workspaceDirectory,
          encoding: "utf8",
        }).trim(),
      ).toBe(upstream);
      expect(
        execFileSync("git", ["branch", "--show-current"], {
          cwd: copies[0]!.workspaceDirectory,
          encoding: "utf8",
        }).trim(),
      ).toBe("feature/from-extension");
      expect(requests).not.toContain("branch_suggestions_request");
    } finally {
      if (projectId) await client.removeProject(projectId);
      await client.close();
      await repo.cleanup();
    }
  });
}
