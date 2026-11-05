import path from "node:path";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { test, expect, type Page } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import {
  addProjectFlowInput,
  chooseAddProjectMethod,
  openAddProjectFlow,
} from "../support/helpers/add-project-flow";
import { expectOpenedProject } from "../support/helpers/project-picker-ui";
import { connectSeedClient, seedWorkspace } from "../support/helpers/seed-client";
import { getServerId } from "../support/helpers/server-id";
import { projectEquivalenceViewKey } from "../support/helpers/project-view-key";
import { createTempGitRepo } from "../support/helpers/workspace";
import { waitForSidebarHydration } from "../support/helpers/workspace-ui";

function workspaceRowTestId(workspaceId: string): string {
  return `sidebar-workspace-row-${getServerId()}:${workspaceId}`;
}

for (const compact of [false, true]) {
  test(`imports an external worktree from the project menu (${compact ? "compact" : "desktop"})`, async ({
    page,
  }, testInfo) => {
    if (compact) await page.setViewportSize({ width: 390, height: 844 });
    const workspace = await seedWorkspace({ repoPrefix: "import-worktree-" });
    const externalPath = path.join(workspace.repoPath, "external worktree");
    try {
      execFileSync("git", ["worktree", "add", "-b", "feature/external", externalPath], {
        cwd: workspace.repoPath,
        stdio: "pipe",
      });
      await gotoAppShell(page);
      if (compact) await page.getByRole("button", { name: "Open menu", exact: true }).click();
      await waitForSidebarHydration(page);
      const key = projectEquivalenceViewKey(workspace.projectKey);
      await page.getByTestId(`sidebar-project-row-${key}`).hover();
      await page.getByTestId(`sidebar-project-kebab-${key}`).click();
      await page.getByTestId(`sidebar-project-menu-import-worktrees-${key}`).click();
      const choice = page.getByRole("checkbox", {
        name: `feature/external, ${externalPath}`,
        exact: true,
      });
      await expect(choice).toBeVisible();
      await choice.click();
      await page.screenshot({ path: testInfo.outputPath("worktree-import-selected.png") });
      await page.getByTestId("import-worktrees-submit").click();
      await expect(choice).toHaveAttribute("aria-checked", "true");
      const open = page.getByRole("button", { name: "Open", exact: true });
      await expect(open).toBeVisible();
      await expect
        .poll(async () => {
          const listed = await workspace.client.fetchWorkspaces({
            filter: { projectId: workspace.projectId },
          });
          return listed.entries.filter((entry) => entry.workspaceDirectory === externalPath).length;
        })
        .toBe(1);
      await page.screenshot({ path: testInfo.outputPath("worktree-import-added.png") });
      await open.click();
      await expect(page.getByTestId("import-worktrees-submit")).toHaveCount(0);
      expect(existsSync(externalPath)).toBe(true);
    } finally {
      await workspace.cleanup();
    }
  });
}

async function archiveWorkspaceFromSidebar(page: Page, workspaceId: string): Promise<void> {
  const serverId = getServerId();
  const row = page.getByTestId(workspaceRowTestId(workspaceId));
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.hover();

  const kebab = page.getByTestId(`sidebar-workspace-kebab-${serverId}:${workspaceId}`);
  await expect(kebab).toBeVisible({ timeout: 10_000 });
  await kebab.click();

  const archiveItem = page.getByTestId(`sidebar-workspace-menu-archive-${serverId}:${workspaceId}`);
  await expect(archiveItem).toBeVisible({ timeout: 10_000 });
  await archiveItem.click();
}

async function removeProjectFromSidebar(page: Page, projectViewKey: string): Promise<void> {
  const projectRow = page.getByTestId(`sidebar-project-row-${projectViewKey}`);
  await expect(projectRow).toBeVisible({ timeout: 30_000 });
  await projectRow.hover();

  const kebab = page.getByTestId(`sidebar-project-kebab-${projectViewKey}`);
  await expect(kebab).toBeVisible({ timeout: 10_000 });
  await kebab.click();

  // Removing a project raises a browser confirm; accept it so the
  // user-confirmed removal proceeds deterministically.
  page.once("dialog", (dialog) => void dialog.accept());

  const removeItem = page.getByTestId(`sidebar-project-menu-remove-${projectViewKey}`);
  await expect(removeItem).toBeVisible({ timeout: 10_000 });
  await removeItem.click();
}

async function addProjectFromPicker(page: Page, projectPath: string): Promise<string> {
  await openAddProjectFlow(page);
  await chooseAddProjectMethod(page, "directory-search");

  const input = addProjectFlowInput(page);
  await input.fill(projectPath);
  await page.keyboard.press("Enter");

  const projectRow = page
    .locator('[data-testid^="sidebar-project-row-"]')
    .filter({ hasText: path.basename(projectPath) })
    .first();
  await expect(projectRow).toBeVisible({ timeout: 30_000 });

  const testId = await projectRow.getAttribute("data-testid");
  expect(testId).not.toBeNull();
  return testId!.replace("sidebar-project-row-", "");
}

async function waitForSidebarProjectListReady(page: Page): Promise<void> {
  await page
    .locator('[data-testid="sidebar-project-empty-state"], [data-testid^="sidebar-project-row-"]')
    .first()
    .waitFor({ state: "visible", timeout: 60_000 });
}

test.describe("Project picker search", () => {
  test("opens a project from a fuzzy directory-name search", async ({
    page,
    projectPickerFixture,
  }) => {
    await gotoAppShell(page);
    await waitForSidebarProjectListReady(page);
    await openAddProjectFlow(page);
    await chooseAddProjectMethod(page, "directory-search");

    const input = addProjectFlowInput(page);
    await input.fill(projectPickerFixture.fuzzyQuery);

    const suggestion = page.getByText(projectPickerFixture.projectName, { exact: false }).first();
    await expect(suggestion).toBeVisible({ timeout: 30_000 });
    await suggestion.click();

    const projectId = await expectOpenedProject(page, projectPickerFixture.projectName);
    projectPickerFixture.rememberProjectId(projectId);
  });

  test("shows a loading state after typing while directory suggestions are pending", async ({
    page,
  }) => {
    await gotoAppShell(page);
    await waitForSidebarProjectListReady(page);
    await openAddProjectFlow(page);
    await chooseAddProjectMethod(page, "directory-search");

    const input = addProjectFlowInput(page);
    await input.fill("paseo-loading-state-no-match");

    await expect(page.getByText("Start typing a path", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Loading...", { exact: true })).toBeVisible();
  });
});

// Projects are parents in the sidebar. Archiving the last workspace leaves the
// project row in place with a ghost "+ New workspace" child row.
test.describe("Project with no workspaces persists", () => {
  test("adding a project starts with only a new-workspace child row", async ({ page }) => {
    const repo = await createTempGitRepo("empty-project-add-");
    const client = await connectSeedClient();
    let projectId: string | null = null;

    try {
      await gotoAppShell(page);
      await waitForSidebarProjectListReady(page);

      projectId = await addProjectFromPicker(page, repo.path);
      const projectRow = page.getByTestId(`sidebar-project-row-${projectId}`);
      await expect(projectRow).toBeVisible({ timeout: 30_000 });
      await expect(projectRow).toContainText(path.basename(repo.path));
      await expect(page.getByTestId(`sidebar-workspace-list-${projectId}`)).toHaveCount(0);

      const newWorkspaceRow = page.getByTestId(`sidebar-project-new-workspace-row-${projectId}`);
      await expect(newWorkspaceRow).toBeVisible({ timeout: 30_000 });
      await expect(newWorkspaceRow).toContainText("New workspace");

      const workspaces = await client.fetchWorkspaces({ filter: { projectId } });
      expect(workspaces.entries).toEqual([]);
    } finally {
      if (projectId) {
        await client.removeProject(projectId).catch(() => undefined);
      }
      await client.close().catch(() => undefined);
      await repo.cleanup().catch(() => undefined);
    }
  });

  test("archiving the only workspace keeps the project row with creation still reachable", async ({
    page,
  }) => {
    const workspace = await seedWorkspace({ repoPrefix: "empty-project-persists-" });

    try {
      const projectViewKey = projectEquivalenceViewKey(workspace.projectKey);
      const projectRow = page.getByTestId(`sidebar-project-row-${projectViewKey}`);
      const newWorkspaceRow = page.getByTestId(
        `sidebar-project-new-workspace-row-${projectViewKey}`,
      );
      const globalNewWorkspace = page.getByTestId("sidebar-global-new-workspace");

      await gotoAppShell(page);
      await waitForSidebarHydration(page);
      await expect(projectRow).toBeVisible({ timeout: 30_000 });
      const workspaceRow = page.getByTestId(workspaceRowTestId(workspace.workspaceId));
      await expect(workspaceRow).toBeVisible({
        timeout: 30_000,
      });
      await workspaceRow.click();
      await expect(page.getByTestId("changes-primary-cta")).toHaveCount(0);

      await archiveWorkspaceFromSidebar(page, workspace.workspaceId);

      // The workspace row goes away, but its project parent stays and exposes a
      // child row for creating the next workspace.
      await expect(page.getByTestId(workspaceRowTestId(workspace.workspaceId))).toHaveCount(0, {
        timeout: 30_000,
      });
      expect(existsSync(workspace.repoPath)).toBe(true);
      await expect(projectRow).toBeVisible({ timeout: 30_000 });
      await expect(newWorkspaceRow).toBeVisible({ timeout: 30_000 });
      await expect(newWorkspaceRow).toContainText("New workspace");
      await expect(globalNewWorkspace).toBeVisible({ timeout: 30_000 });

      // The project survives a reload after its last workspace is archived.
      await page.reload();
      await waitForSidebarHydration(page);
      await expect(projectRow).toBeVisible({ timeout: 30_000 });
      await expect(newWorkspaceRow).toBeVisible({ timeout: 30_000 });
    } finally {
      await workspace.cleanup();
    }
  });
});

test.describe("Project remove", () => {
  test("removing a project from project actions removes it from the sidebar", async ({ page }) => {
    const workspace = await seedWorkspace({ repoPrefix: "project-remove-sidebar-" });
    let readdedProjectId: string | null = null;

    try {
      const projectViewKey = projectEquivalenceViewKey(workspace.projectKey);
      const projectRow = page.getByTestId(`sidebar-project-row-${projectViewKey}`);

      await gotoAppShell(page);
      await waitForSidebarHydration(page);
      await expect(projectRow).toBeVisible({ timeout: 30_000 });
      await expect(page.getByTestId(workspaceRowTestId(workspace.workspaceId))).toBeVisible({
        timeout: 30_000,
      });

      await removeProjectFromSidebar(page, projectViewKey);

      await expect(page.getByTestId(workspaceRowTestId(workspace.workspaceId))).toHaveCount(0, {
        timeout: 30_000,
      });
      await expect(projectRow).toHaveCount(0, { timeout: 30_000 });

      await page.reload();
      await waitForSidebarProjectListReady(page);
      await expect(projectRow).toHaveCount(0, { timeout: 30_000 });

      const readded = await workspace.client.addProject(workspace.repoPath);
      expect(readded.error).toBeNull();
      expect(readded.project).not.toBeNull();
      readdedProjectId = readded.project?.projectId ?? "";
      const readdedProjectKey = readded.project?.projectKey ?? "";
      expect(readdedProjectId).not.toBe(workspace.projectId);
      expect(readdedProjectKey).toBe(workspace.projectKey);
      expect(readded.project?.projectDisplayName).toBe(workspace.projectDisplayName);

      await page.reload();
      await waitForSidebarHydration(page);
      await expect(projectRow).toBeVisible({ timeout: 30_000 });
      await expect(projectRow).toContainText(workspace.projectDisplayName);
      await expect(projectRow).not.toContainText(workspace.repoPath);
      await expect(
        page.getByTestId(
          `sidebar-project-new-workspace-row-${projectEquivalenceViewKey(readdedProjectKey)}`,
        ),
      ).toBeVisible({ timeout: 30_000 });
    } finally {
      if (readdedProjectId) {
        await workspace.client.removeProject(readdedProjectId).catch(() => undefined);
      }
      await workspace.cleanup();
    }
  });
});
