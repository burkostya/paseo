import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { openChangesPanel } from "../support/helpers/branch-switcher";
import { seedWorkspace } from "../support/helpers/seed-client";
import { getServerId } from "../support/helpers/server-id";
import {
  switchWorkspaceViaSidebar,
  waitForSidebarHydration,
} from "../support/helpers/workspace-ui";

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

function addComparisonBranches(cwd: string): void {
  git(cwd, ["checkout", "-b", "feature"]);
  writeFileSync(path.join(cwd, "shared-change.txt"), "shared\n");
  git(cwd, ["add", "shared-change.txt"]);
  git(cwd, ["commit", "-m", "Shared feature commit"]);
  git(cwd, ["branch", "release"]);
  writeFileSync(path.join(cwd, "feature-only.txt"), "feature only\n");
  git(cwd, ["add", "feature-only.txt"]);
  git(cwd, ["commit", "-m", "Feature-only commit"]);
}

async function selectDiffMode(page: Page, mode: "committed" | "uncommitted"): Promise<void> {
  await page.getByTestId("changes-diff-status-trigger").click();
  const option = page.getByTestId(`changes-diff-mode-${mode}`);
  await expect(option).toBeVisible({ timeout: 10_000 });
  await option.click();
}

async function selectBaseBranch(page: Page, branch: string): Promise<void> {
  await page.getByTestId("changes-diff-base-trigger").click();
  const picker = page.getByTestId("combobox-desktop-container");
  await expect(picker).toBeVisible({ timeout: 30_000 });
  const search = page.getByPlaceholder("Filter branches...");
  await expect(search).toBeVisible({ timeout: 30_000 });
  await search.fill(branch);
  const option = page.getByTestId(`changes-diff-base-${branch}`);
  await expect(option).toBeVisible({ timeout: 30_000 });
  await option.click();
  await expect(picker).not.toBeVisible({ timeout: 30_000 });
}

test("selects, persists, and resets the committed diff base branch", async ({ page }) => {
  test.setTimeout(120_000);
  const serverId = getServerId();
  const workspace = await seedWorkspace({ repoPrefix: "diff-base-picker-" });
  addComparisonBranches(workspace.repoPath);

  try {
    await gotoAppShell(page);
    await waitForSidebarHydration(page);
    await switchWorkspaceViaSidebar({ page, serverId, workspaceId: workspace.workspaceId });
    await openChangesPanel(page);

    const baseTrigger = page.getByTestId("changes-diff-base-trigger");
    await expect(baseTrigger).toContainText("main", { timeout: 30_000 });
    await expect(page.getByText("shared-change.txt", { exact: true })).toBeVisible();
    await expect(page.getByText("feature-only.txt", { exact: true })).toBeVisible();

    await selectBaseBranch(page, "release");
    await expect(baseTrigger).toContainText("release");
    await expect(page.getByText("feature-only.txt", { exact: true })).toBeVisible();
    await expect(page.getByText("shared-change.txt", { exact: true })).toHaveCount(0);

    await page.reload();
    await expect(baseTrigger).toContainText("release", { timeout: 30_000 });

    await selectDiffMode(page, "uncommitted");
    await expect(baseTrigger).toHaveCount(0);
    await expect(page.getByText("No uncommitted changes", { exact: true })).toBeVisible();

    await selectDiffMode(page, "committed");
    await expect(baseTrigger).toContainText("release");
    await baseTrigger.click();
    const defaultOption = page.getByTestId("changes-diff-base-default");
    await expect(defaultOption).toBeVisible({ timeout: 30_000 });
    await defaultOption.click();

    await expect(baseTrigger).toContainText("main");
    await expect(page.getByText("shared-change.txt", { exact: true })).toBeVisible();
    await expect(page.getByText("feature-only.txt", { exact: true })).toBeVisible();
  } finally {
    await workspace.cleanup();
  }
});
