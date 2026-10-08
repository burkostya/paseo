import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { openChangesPanel } from "../support/helpers/branch-switcher";
import { seedWorkspace } from "../support/helpers/seed-client";
import { getServerId } from "../support/helpers/server-id";
import { closeSidebarDisplayPreferences, openSidebarDisplayPage } from "../support/helpers/sidebar";
import {
  switchWorkspaceViaSidebar,
  waitForSidebarHydration,
} from "../support/helpers/workspace-ui";

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

async function choose(page: Page, id: string): Promise<void> {
  await page.getByTestId("changes-comparison-trigger").click();
  await page.getByTestId(id).click();
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
}

test("shares comparison settings, persists overrides, and matches sidebar counts to Changes", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const serverId = getServerId();
  const workspace = await seedWorkspace({ repoPrefix: "diff-base-picker-" });
  const cwd = workspace.repoPath;
  git(cwd, ["checkout", "-b", "feature"]);
  writeFileSync(path.join(cwd, "shared-change.txt"), "shared\n");
  git(cwd, ["add", "."]);
  git(cwd, ["commit", "-m", "Shared"]);
  git(cwd, ["branch", "release"]);
  git(cwd, ["update-ref", "refs/remotes/team/release", "HEAD"]);
  writeFileSync(path.join(cwd, "feature-only.txt"), "feature\n");
  git(cwd, ["add", "."]);
  git(cwd, ["commit", "-m", "Feature"]);
  writeFileSync(path.join(cwd, "working.txt"), "working\n");
  const stat = page.getByTestId(`workspace-comparison-stat-${workspace.workspaceId}`);
  const trigger = page.getByTestId("changes-comparison-trigger");
  try {
    await gotoAppShell(page);
    await waitForSidebarHydration(page);
    await switchWorkspaceViaSidebar({ page, serverId, workspaceId: workspace.workspaceId });
    await openSidebarDisplayPage(page, "sidebar-display-show");
    await page.getByTestId("sidebar-workspace-trailing-diff").click();
    await closeSidebarDisplayPreferences(page);
    await openChangesPanel(page);
    await expect(trigger).toHaveText("Uncommitted changes");
    await expect(stat).toContainText("+1");
    await expect(page.getByText("working.txt", { exact: true })).toBeVisible();
    await choose(page, "comparison-branch-refs/remotes/team/release");
    await expect(trigger).toContainText("team/release");
    await expect(stat).toContainText("+2");
    await expect(page.getByTestId("changes-selected-diff-stat").first()).toContainText("+2");
    await expect(page.getByText("working.txt", { exact: true })).toBeVisible();
    writeFileSync(path.join(cwd, "working.txt"), "working\nmore\n");
    await expect(stat).toContainText("+3");
    await expect(page.getByTestId("changes-selected-diff-stat").first()).toContainText("+3");
    writeFileSync(path.join(cwd, "working.txt"), "working\n");
    await expect(stat).toContainText("+2");
    await expect(page.getByText("feature-only.txt", { exact: true })).toBeVisible();
    await expect(page.getByText("shared-change.txt", { exact: true })).toHaveCount(0);
    const projectRow = page.locator('[data-testid^="sidebar-project-row-"]').first();
    await projectRow.hover();
    await page.locator('[data-testid^="sidebar-project-kebab-"]').first().click();
    await page.getByTestId("comparison-menu").click();
    await page.getByTestId("comparison-search").fill("main");
    await page.getByTestId("comparison-branch-refs/heads/main").click();
    await expect(page.getByText("Saved", { exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    // A second real client changes the project; the workspace override must survive.
    await workspace.client.setDiffComparison(
      { kind: "project", projectId: workspace.projectId },
      { mode: "base", baseRef: "refs/heads/main" },
    );
    await expect(trigger).toContainText("team/release");
    await page.reload();
    await expect(trigger).toContainText("team/release", { timeout: 30_000 });
    await page
      .getByTestId(`sidebar-workspace-row-${serverId}:${workspace.workspaceId}`)
      .first()
      .click({ button: "right" });
    await page.getByTestId("comparison-menu").click();
    await page.getByTestId("comparison-inherit").click();
    await expect(page.getByText("Saved", { exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await expect(trigger).toContainText("main");
    await expect(stat).toContainText("+3");
    await expect(page.getByText("shared-change.txt", { exact: true })).toBeVisible();
    await choose(page, "comparison-uncommitted");
    git(cwd, ["add", "."]);
    git(cwd, ["commit", "-m", "Working changes"]);
    await expect(trigger).toHaveText("Uncommitted changes");
    await expect(stat).toHaveCount(0);
    await expect(page.getByText("No changes to display", { exact: true })).toBeVisible();
    await choose(page, "comparison-branch-refs/remotes/team/release");
    git(cwd, ["update-ref", "-d", "refs/remotes/team/release"]);
    await expect(stat).toHaveText("!");
    await choose(page, "comparison-uncommitted");
    await expect(stat).toHaveCount(0);
    await choose(page, "comparison-branch-refs/heads/main");
    await stat.click();
    await expect(page.getByTestId("workspace-tab-working_diff").first()).toBeVisible();
    await expect(
      page.getByTestId("working-diff-panel").getByTestId("changes-comparison-trigger"),
    ).toContainText("main");
    await page.screenshot({ path: "/tmp/paseo-comparison-desktop.png" });
  } finally {
    await workspace.cleanup();
  }
});

test("keeps a failed selection actionable and uses the compact comparison sheet", async ({
  page,
}) => {
  const workspace = await seedWorkspace({ repoPrefix: "diff-comparison-failure-" });
  const serverId = getServerId();
  // Forward to the real daemon with an expired identity once, then allow the retry.
  let rejectNext = true;
  await page.routeWebSocket(/\/ws(?:\?|$)/, (browser) => {
    const server = browser.connectToServer();
    browser.onMessage((message) => {
      if (typeof message === "string") {
        const envelope = JSON.parse(message) as {
          message?: { type?: string; target?: { kind: string; workspaceId: string } };
        };
        if (rejectNext && envelope.message?.type === "git.comparison.set.request") {
          rejectNext = false;
          envelope.message.target = { kind: "workspace", workspaceId: "expired-comparison-target" };
          server.send(JSON.stringify(envelope));
          return;
        }
      }
      server.send(message);
    });
    server.onMessage((message) => browser.send(message));
  });
  try {
    await gotoAppShell(page);
    await waitForSidebarHydration(page);
    await switchWorkspaceViaSidebar({ page, serverId, workspaceId: workspace.workspaceId });
    await openChangesPanel(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: "Open Explorer sidebar", exact: true }).click();
    const trigger = page
      .getByTestId("changes-comparison-trigger")
      .filter({ visible: true })
      .first();
    await trigger.click();
    const option = page
      .getByTestId("comparison-branch-refs/heads/main")
      .filter({ visible: true })
      .first();
    await option.click();
    await expect(page.getByText("Workspace not found", { exact: true })).toBeVisible();
    await expect(trigger).toHaveText("Uncommitted changes");
    await expect(option).toBeEnabled();
    await option.click();
    await expect(page.getByText("Saved", { exact: true })).toBeVisible();
    await expect(trigger).toContainText("main");
    await expect(page.getByText("Workspace not found", { exact: true })).toHaveCount(0);
    await page.screenshot({ path: "/tmp/paseo-comparison-compact.png" });
  } finally {
    await workspace.cleanup();
  }
});
