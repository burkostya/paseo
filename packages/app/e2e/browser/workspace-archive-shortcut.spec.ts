import { execFileSync } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  connectNewWorkspaceDaemonClient,
  openProjectViaDaemon,
} from "../support/helpers/new-workspace";
import { createTempGitRepo } from "../support/helpers/workspace";
import { existsSync } from "node:fs";
import { expect, test } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { seedWorkspace } from "../support/helpers/seed-client";
import {
  expectWorkspaceAbsentFromSidebar,
  selectWorkspaceInSidebar,
} from "../support/helpers/sidebar";
import { waitForSidebarHydration } from "../support/helpers/workspace-ui";

test.describe("Workspace archive shortcut", () => {
  test("archives the selected workspace without removing its local checkout", async ({ page }) => {
    const workspace = await seedWorkspace({ repoPrefix: "archive-shortcut-" });

    try {
      await gotoAppShell(page);
      await waitForSidebarHydration(page);
      await selectWorkspaceInSidebar(page, workspace.workspaceId);

      const modifier = process.platform === "darwin" ? "Meta" : "Control";
      await page.keyboard.press(`${modifier}+Shift+Backspace`);

      await expectWorkspaceAbsentFromSidebar(page, workspace.workspaceId);
      expect(existsSync(workspace.repoPath)).toBe(true);
    } finally {
      await workspace.cleanup();
    }
  });
});

test("jj archive warns that ignored files keep the working copy on disk", async ({ page }) => {
  const repo = await createTempGitRepo("jj-archive-retain-", {
    files: [{ path: ".gitignore", content: ".env\n" }],
  });
  execFileSync("jj", ["git", "init", "--colocate", repo.path], { stdio: "pipe" });
  const client = await connectNewWorkspaceDaemonClient();
  let copyRoot: string | undefined;
  try {
    const project = await openProjectViaDaemon(client, repo.path);
    const created = await client.createWorkspace({
      source: { kind: "working-copy", projectId: project.projectId },
    });
    if (created.error || !created.workspace?.workspaceDirectory)
      throw new Error(created.error ?? "Missing workspace");
    const workspace = created.workspace;
    copyRoot = workspace.workspaceDirectory;
    await writeFile(path.join(copyRoot, ".env"), "SECRET=retained\n");
    await gotoAppShell(page);
    await waitForSidebarHydration(page);
    await selectWorkspaceInSidebar(page, workspace.id);
    const modifier = process.platform === "darwin" ? "Meta" : "Control";
    await page.keyboard.press(`${modifier}+Shift+Backspace`);
    await expectWorkspaceAbsentFromSidebar(page, workspace.id);
    await expect(page.getByText(/Working copy retained at/)).toBeVisible();
    await expect(page.getByText(/files outside the jj snapshot: .env/)).toBeVisible();
    expect(await readFile(path.join(copyRoot, ".env"), "utf8")).toBe("SECRET=retained\n");
    await page.screenshot({ path: test.info().outputPath("jj-archive-retained-warning.png") });
  } finally {
    await client.close();
    if (copyRoot) await rm(copyRoot, { recursive: true, force: true });
    await repo.cleanup();
  }
});
