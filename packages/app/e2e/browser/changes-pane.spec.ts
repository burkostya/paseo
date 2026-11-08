import { openCommandCenter } from "../support/helpers/command-center";
import {
  loadSessionMessageReaders,
  selectWorkspaceIsolation,
} from "../support/helpers/new-workspace";
import { copyPluginExample } from "../support/helpers/plugin-fixture";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, rename, rmdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { type Locator, type Page } from "@playwright/test";
import {
  buildHostWorkspaceRoute,
  buildSettingsSectionRoute,
  buildNewWorkspaceRoute,
} from "../../src/utils/host-routes";
import { test, expect } from "../support/fixtures";
import { daemonWsRoutePattern } from "../support/helpers/daemon-port";
import { getServerId } from "../support/helpers/server-id";
import { connectSeedClient } from "../support/helpers/seed-client";
import { configureTempComparisonBase, createTempGitRepo } from "../support/helpers/workspace";
import { openChangesPanel, waitForWorkspaceTabsVisible } from "../support/helpers/workspace-tabs";

interface DirtyWorkspace {
  id: string;
  repoPath: string;
}

interface WorkspaceFixtureOptions {
  includeDeletedFile?: boolean;
  includeNestedFolders?: boolean;
  includeRenamedFile?: boolean;
  // A root-level file whose name sorts BEFORE the root-level "src" directory.
  // zz-untracked.txt cannot stand in for it: "src" < "zz", so that file lands
  // last whether paths are compared whole or segment by segment.
  includeRootFileSortingFirst?: boolean;
  includeUntrackedFile?: boolean;
}

interface CleanupTask {
  run: () => Promise<void>;
}

const cleanupTasks: CleanupTask[] = [];
const APP_SETTINGS_KEY = "@paseo:app-settings";

function changesTree(page: Page) {
  return page.getByTestId("changes-file-tree").filter({ visible: true });
}

function diffHeaderForPath(panel: Locator, filePath: string): Locator {
  return panel.locator(`[data-diff-header-path="${filePath}"]`).getByTestId(/^diff-file-\d+$/);
}

async function readFileIfPresent(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

// COMPAT(vcsGitUi): v0.15.2; retain old Git controls for pre-base-comparison hosts until 2027-06-06.
async function useLegacyGitSurface(page: Page): Promise<void> {
  await page.routeWebSocket(daemonWsRoutePattern(), (browser) => {
    const server = browser.connectToServer();
    browser.onMessage((message) => server.send(message));
    server.onMessage((message) => browser.send(legacyGitMessage(message)));
  });
}

function legacyGitMessage(message: string | Buffer): string | Buffer {
  if (typeof message !== "string") return message;
  const envelope = JSON.parse(message) as {
    message?: { type?: string; payload?: { status?: string; features?: Record<string, unknown> } };
  };
  if (envelope.message?.type === "status" && envelope.message.payload?.status === "server_info") {
    delete envelope.message.payload.features?.vcsComparisonViews;
    delete envelope.message.payload.features?.vcsBaseComparisons;
  }
  return JSON.stringify(envelope);
}

async function failNextDiscardRequest(page: Page): Promise<void> {
  await page.routeWebSocket(daemonWsRoutePattern(), (browserSocket) => {
    const serverSocket = browserSocket.connectToServer();
    browserSocket.onMessage((message) => {
      if (typeof message === "string") {
        const envelope = JSON.parse(message) as {
          message?: { type?: string; cwd?: string; requestId?: string };
        };
        if (envelope.message?.type === "checkout.discard_changes.request") {
          browserSocket.send(
            JSON.stringify({
              type: "session",
              message: {
                type: "checkout.discard_changes.response",
                payload: {
                  cwd: envelope.message.cwd,
                  success: false,
                  error: { code: "UNKNOWN", message: "Injected revert failure" },
                  requestId: envelope.message.requestId,
                },
              },
            }),
          );
          return;
        }
      }
      serverSocket.send(message);
    });
    serverSocket.onMessage((message) => browserSocket.send(legacyGitMessage(message)));
  });
}

const CHANGES_PREFERENCES_KEY = "@paseo:changes-preferences";

const BEFORE = `import { useLayoutEffect, useMemo, useRef, useState } from "react";

interface UseMountedTabSetInput {
  activeTabId: string | null;
  allTabIds: string[];
  cap: number;
}

interface UseMountedTabSetResult {
  mountedTabIds: Set<string>;
}

function createInitialMountedTabIds(input: UseMountedTabSetInput): Set<string> {
  if (!input.activeTabId || !input.allTabIds.includes(input.activeTabId)) {
    return new Set<string>();
  }
  return new Set<string>([input.activeTabId]);
}

function setsEqual(left: Set<string>, right: Set<string>): boolean {
  if (left.size !== right.size) {
    return false;
  }
  for (const value of left) {
    if (!right.has(value)) {
      return false;
    }
  }
  return true;
}

export function useMountedTabSet(input: UseMountedTabSetInput): UseMountedTabSetResult {
  const { activeTabId, allTabIds, cap } = input;
  const allTabIdsKey = allTabIds.join("\\u0000");
  const availableTabIds = useMemo(() => {
    void allTabIdsKey;
    return new Set(allTabIds);
  }, [allTabIds, allTabIdsKey]);
  const [mountedTabIds, setMountedTabIds] = useState(() => createInitialMountedTabIds(input));
  const lruRef = useRef(activeTabId && allTabIds.includes(activeTabId) ? [activeTabId] : []);

  useLayoutEffect(() => {
    const nextLru = lruRef.current.filter((tabId) => availableTabIds.has(tabId));
    if (activeTabId && availableTabIds.has(activeTabId)) {
      const existingIndex = nextLru.indexOf(activeTabId);
      if (existingIndex >= 0) {
        nextLru.splice(existingIndex, 1);
      }
      nextLru.unshift(activeTabId);
    }
    if (nextLru.length > cap) {
      nextLru.length = cap;
    }

    lruRef.current = nextLru;
    setMountedTabIds((previousMountedTabIds) => {
      const nextMountedTabIds = new Set(nextLru);
      return setsEqual(previousMountedTabIds, nextMountedTabIds)
        ? previousMountedTabIds
        : nextMountedTabIds;
    });
  }, [activeTabId, availableTabIds, cap]);

  return { mountedTabIds };
}
`;

const AFTER = `import { useLayoutEffect, useMemo, useRef, useState } from "react";

interface UseMountedTabSetInput {
  activeTabId: string | null;
  allTabIds: string[];
  cap: number;
}

interface UseMountedTabSetResult {
  mountedTabIds: Set<string>;
}

interface DeriveRenderMountedTabIdsInput {
  activeTabId: string | null;
  availableTabIds: Set<string>;
  cap: number;
  mountedTabIds: Set<string>;
}

function createInitialMountedTabIds(input: UseMountedTabSetInput): Set<string> {
  if (!input.activeTabId || !input.allTabIds.includes(input.activeTabId)) {
    return new Set<string>();
  }
  return new Set<string>([input.activeTabId]);
}

function setsEqual(left: Set<string>, right: Set<string>): boolean {
  if (left.size !== right.size) {
    return false;
  }
  for (const value of left) {
    if (!right.has(value)) {
      return false;
    }
  }
  return true;
}

function deriveRenderMountedTabIds(input: DeriveRenderMountedTabIdsInput): Set<string> {
  const { activeTabId, availableTabIds, cap, mountedTabIds } = input;
  if (!activeTabId || !availableTabIds.has(activeTabId) || mountedTabIds.has(activeTabId)) {
    return mountedTabIds;
  }

  const next = new Set<string>([activeTabId]);
  const maxSize = Math.max(1, cap);
  for (const tabId of mountedTabIds) {
    if (next.size >= maxSize) {
      break;
    }
    if (availableTabIds.has(tabId)) {
      next.add(tabId);
    }
  }
  return next;
}

export function useMountedTabSet(input: UseMountedTabSetInput): UseMountedTabSetResult {
  const { activeTabId, allTabIds, cap } = input;
  const allTabIdsKey = allTabIds.join("\\u0000");
  const availableTabIds = useMemo(() => {
    void allTabIdsKey;
    return new Set(allTabIds);
  }, [allTabIds, allTabIdsKey]);
  const [mountedTabIds, setMountedTabIds] = useState(() => createInitialMountedTabIds(input));
  const lruRef = useRef(activeTabId && allTabIds.includes(activeTabId) ? [activeTabId] : []);
  const renderMountedTabIds = useMemo(
    () =>
      deriveRenderMountedTabIds({
        activeTabId,
        availableTabIds,
        cap,
        mountedTabIds,
      }),
    [activeTabId, availableTabIds, cap, mountedTabIds],
  );

  useLayoutEffect(() => {
    const nextLru = lruRef.current.filter((tabId) => availableTabIds.has(tabId));
    if (activeTabId && availableTabIds.has(activeTabId)) {
      const existingIndex = nextLru.indexOf(activeTabId);
      if (existingIndex >= 0) {
        nextLru.splice(existingIndex, 1);
      }
      nextLru.unshift(activeTabId);
    }
    if (nextLru.length > cap) {
      nextLru.length = cap;
    }

    lruRef.current = nextLru;
    setMountedTabIds((previousMountedTabIds) => {
      const nextMountedTabIds = new Set(nextLru);
      return setsEqual(previousMountedTabIds, nextMountedTabIds)
        ? previousMountedTabIds
        : nextMountedTabIds;
    });
  }, [activeTabId, availableTabIds, cap]);

  return { mountedTabIds: renderMountedTabIds };
}
`;

test.afterEach(async () => {
  for (const task of cleanupTasks.splice(0)) {
    await task.run();
  }
});

test("Changes opens All changes for a clean checkout", async ({ page }) => {
  const workspace = await createWorkspaceWithCommittedDiff();
  const reviewKey = `review:server=${encodeURIComponent(getServerId())}:workspace=${encodeURIComponent(workspace.id)}:mode=all:base=refs%2Fremotes%2Fpaseo-fixture%2Fmain:ignoreWhitespace=false`;
  await page.addInitScript(
    ({ key }) => {
      if (localStorage.getItem("@paseo:review-draft-store")) return;
      localStorage.setItem(
        "@paseo:review-draft-store",
        JSON.stringify({
          version: 2,
          state: {
            drafts: {
              [key]: [
                {
                  id: "legacy-comment",
                  filePath: "committed-only.ts",
                  side: "new",
                  lineNumber: 1,
                  body: "Saved before the common VCS screen",
                  createdAt: "2026-11-01T00:00:00Z",
                  updatedAt: "2026-11-01T00:00:00Z",
                },
              ],
            },
          },
        }),
      );
    },
    { key: reviewKey },
  );
  await openWorkspaceChangesSurface(page, workspace, 90_000);

  const panel = page.getByTestId("working-diff-panel").filter({ visible: true });
  const tree = page.getByTestId("changes-tree-panel").filter({ visible: true });
  await expect(tree.getByTestId("vcs-comparison")).toContainText("Workspace settings");
  await expect(panel.getByTestId("diff-file-0")).toHaveAccessibleName("committed-only.ts, +1, -0");
  await expect(
    panel.getByText("Saved before the common VCS screen", { exact: true }),
  ).toBeVisible();
  await panel.getByTestId("vcs-comparison").click();
  await page.getByRole("button", { name: "Committed", exact: true }).last().click();
  await expect(panel.getByTestId("diff-file-0")).toHaveAccessibleName("committed-only.ts, +1, -0");
  await expect(panel.getByText("Saved before the common VCS screen", { exact: true })).toHaveCount(
    0,
  );
  await panel.getByTestId("vcs-comparison").click();
  await page.getByRole("button", { name: "Workspace settings", exact: true }).last().click();
  await expect(
    panel.getByText("Saved before the common VCS screen", { exact: true }),
  ).toBeVisible();
  await page.reload();
  await openChangesPanel(page, 30_000);
  await expect(panel.getByTestId("diff-file-0")).toBeVisible({ timeout: 30_000 });
  await expect(
    panel.getByText("Saved before the common VCS screen", { exact: true }),
  ).toBeVisible();
  await expect(page.getByTestId("git-legacy-review")).toHaveCount(0);
  await tree.getByTestId("vcs-comparison").click();
  await page.getByRole("button", { name: "Committed", exact: true }).last().click();
  await tree.getByTestId("diff-tree-file-0-toggle").click();
  await expect(panel.getByTestId("vcs-comparison")).toContainText("Committed");
  await expect(panel.getByText("Saved before the common VCS screen", { exact: true })).toHaveCount(
    0,
  );
  await page.reload();
  await expect(panel.getByTestId("vcs-comparison")).toContainText("Committed");
  await expect(panel.getByTestId("diff-file-0")).toHaveAccessibleName("committed-only.ts, +1, -0");
});

test("Git retains Changes when the host lacks VCS comparison views", async ({ page }) => {
  await useLegacyGitSurface(page);
  const workspace = await createWorkspaceWithCommittedDiff();
  await openWorkspaceChangesSurface(page, workspace, 90_000);
  const panel = page.getByTestId("working-diff-panel").filter({ visible: true });
  await expect(panel.getByTestId("diff-file-0")).toHaveAccessibleName("committed-only.ts, +1, -0");
  await expect(page.getByTestId("git-modern-vcs")).toHaveCount(0);
  await expect(page.getByTestId("vcs-panel")).toHaveCount(0);
});

test("All changes combines committed and pending edits and preserves an unfinished review", async ({
  page,
  context,
}) => {
  const workspace = await createWorkspaceWithNetDiff();
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await configureDiffPresentation(page, { layout: "unified", wrapLines: false });
  await openWorkspaceChangesSurface(page, workspace);
  const tree = page.getByTestId("changes-tree-panel").filter({ visible: true });
  const panel = page.getByTestId("working-diff-panel").filter({ visible: true });
  const mode = tree.getByTestId("vcs-comparison");
  await expect(mode).toContainText("Workspace settings");
  await expectNetComparisonFiles(page, ["a-tracked.ts", "b-committed.ts"]);
  await expectRenderedAddedLine(page, "committed");

  await test.step("an unfinished review survives the first dirty edit", async () => {
    await startReviewOnFirstChangedLine(page);
    await page
      .getByRole("textbox", { name: "Review comment" })
      .fill("Unfinished review stays here");
    await writeFile(path.join(workspace.repoPath, "c-untracked.txt"), "untracked\n");
    await expectNetComparisonFiles(page, ["a-tracked.ts", "b-committed.ts", "c-untracked.txt"]);
    await expect(mode).toContainText("Workspace settings");
    await expect(page.getByRole("textbox", { name: "Review comment" })).toHaveValue(
      "Unfinished review stays here",
    );
    await cancelInlineReview(page);
  });
  await test.step("pending edits form a live net patch over the committed edit", async () => {
    await writeFile(path.join(workspace.repoPath, "a-tracked.ts"), "working\n");
    await expectRenderedAddedLine(page, "working");
    await expect(panel.getByTestId("diff-file-0")).toHaveAccessibleName("a-tracked.ts, +1, -1");
  });
  await test.step("committing the same contents preserves the rendered comparison", async () => {
    execFileSync("git", ["add", "--all"], { cwd: workspace.repoPath });
    execFileSync("git", ["commit", "-m", "Commit pending changes"], { cwd: workspace.repoPath });
    await expect(panel.getByTestId("vcs-refresh")).toBeEnabled();
    await expect(mode).toContainText("Workspace settings");
    await expectNetComparisonFiles(page, ["a-tracked.ts", "b-committed.ts", "c-untracked.txt"]);
    await expectRenderedAddedLine(page, "working");
  });
  await test.step("undoing to the comparison base removes the net change", async () => {
    await writeFile(path.join(workspace.repoPath, "a-tracked.ts"), "base\n");
    await expectNetComparisonFiles(page, ["b-committed.ts", "c-untracked.txt"]);
    await expect(mode).toContainText("Workspace settings");
  });
});

test("Changes keeps a manual comparison when checkout dirtiness changes", async ({ page }) => {
  const workspace = await createWorkspaceWithMountedTabDiff();
  await openWorkspaceChanges(page, workspace);

  const tree = page.getByTestId("changes-tree-panel").filter({ visible: true });
  const mode = tree.getByTestId("vcs-comparison");
  await expect(mode).toContainText("Workspace settings");

  await selectChangesComparison(page, "Committed");
  await expect(mode).toContainText("Workspace settings");
  await expect(tree.getByText("No changes", { exact: true })).toBeVisible();

  execFileSync("git", ["add", "--all"], { cwd: workspace.repoPath });
  execFileSync("git", ["commit", "-m", "Commit working changes"], { cwd: workspace.repoPath });
  await expect(mode).toContainText("Workspace settings");
  await expect(tree.getByText("use-mounted-tab-set.ts", { exact: true })).toBeVisible();

  await writeFile(path.join(workspace.repoPath, "new-working-change.txt"), "uncommitted\n");
  await expect(tree.getByText("new-working-change.txt", { exact: true })).toHaveCount(0);
  await expect(mode).toContainText("Workspace settings");

  await selectChangesComparison(page, "Uncommitted");
  execFileSync("git", ["add", "--all"], { cwd: workspace.repoPath });
  execFileSync("git", ["commit", "-m", "Commit new working change"], { cwd: workspace.repoPath });
  await expect(tree.getByText("No changes", { exact: true })).toBeVisible({
    timeout: 30_000,
  });
  await expect(mode).toContainText("Workspace settings");
  await writeFile(path.join(workspace.repoPath, "another-working-change.txt"), "pending\n");
  await expect(tree.getByText("another-working-change.txt", { exact: true })).toBeVisible({
    timeout: 30_000,
  });
  await expect(mode).toContainText("Workspace settings");
});

test("an empty Changes comparison can switch to the populated comparison", async ({ page }) => {
  const workspace = await createWorkspaceWithCommittedDiff();
  await openWorkspaceChangesSurface(page, workspace);

  const panel = page.getByTestId("working-diff-panel").filter({ visible: true });
  const tree = page.getByTestId("changes-tree-panel").filter({ visible: true });
  const mode = tree.getByTestId("vcs-comparison");
  await selectChangesComparison(page, "Committed");
  await expect(panel.getByTestId("diff-file-0")).toHaveAccessibleName("committed-only.ts, +1, -0");

  await selectChangesComparison(page, "Uncommitted");

  await expect(tree.getByText("No changes", { exact: true })).toBeVisible();
  await expect(panel.getByText("No changes", { exact: true })).toBeVisible();
  await selectChangesComparison(page, "Committed");
  await expect(mode).toContainText("Workspace settings");
  await expect(panel.getByTestId("diff-file-0")).toHaveAccessibleName("committed-only.ts, +1, -0");
});

test("Changes comparison controls the working diff and tree selection focuses its file", async ({
  page,
}) => {
  const workspace = await createWorkspaceWithScrollableComparisons();
  await openWorkspaceChangesSurface(page, workspace);

  await selectChangesComparison(page, "Committed");
  await expectWorkingComparisonFiles(page, "committed");
  await selectChangedFileAndExpectFocused(page, "committed/50-target.ts");

  await selectChangesComparison(page, "Uncommitted");
  await expectWorkingComparisonFiles(page, "uncommitted");
  await selectChangedFileAndExpectFocused(page, "uncommitted/50-target.ts");
});

test("changes file actions open below the right-click without a reserved kebab", async ({
  page,
}) => {
  const workspace = await createWorkspaceWithMountedTabDiff({ includeDeletedFile: true });
  await useUnwrappedDiffLines(page);
  await openWorkspaceChanges(page, workspace);

  const deletedFileName = page.getByTestId("diff-file-1");
  await expect(deletedFileName).toHaveAccessibleName(/zz-deleted\.ts/);
  await deletedFileName.dblclick();
  expect(await page.evaluate(() => window.getSelection()?.toString() ?? "")).toBe("");
  await expect(page.getByTestId(/diff-file-\d+-actions/)).toHaveCount(0);
  await page.getByTestId("diff-file-1-toggle").click({ button: "right" });
  await expect(page.getByText("Copy path")).toBeVisible();
  await page.getByText("Copy path", { exact: true }).click({ button: "right" });
  await expect(page.getByText("Copy path")).toBeVisible();
  await expect(page.getByTestId("diff-file-1-open-file")).toHaveCount(0);
  await page.keyboard.press("Escape");

  const fileRow = page.getByTestId("diff-file-0-toggle");
  const fileRowBounds = await fileRow.boundingBox();
  expect(fileRowBounds).not.toBeNull();
  await fileRow.click({ button: "right", position: { x: 80, y: 10 } });
  await expect(page.getByTestId("diff-file-0-open-file")).toBeVisible();
  const menuBounds = await page.getByTestId("diff-file-0-context-menu").boundingBox();
  expect(menuBounds).not.toBeNull();
  expect(Math.abs(menuBounds!.x - (fileRowBounds!.x + 80))).toBeLessThanOrEqual(1);
  expect(menuBounds!.y).toBeGreaterThan(fileRowBounds!.y + 10);
  await page.getByTestId("diff-file-0-open-file").click();

  await expect(page.getByTestId("workspace-file-pane")).toBeVisible();
  await expect(page.getByTestId("workspace-tab-file_src/use-mounted-tab-set.ts")).toBeVisible();
});

test("canvas file headers select without toggling for context menu and long press", async ({
  page,
}) => {
  const workspace = await createWorkspaceWithMountedTabDiff({ includeDeletedFile: true });
  await useUnwrappedDiffLines(page);
  await openWorkspaceChanges(page, workspace);

  const firstFile = page.getByTestId("diff-file-0-toggle");
  const deletedFile = page.getByTestId("diff-file-1-toggle");
  await deletedFile.click({ button: "right" });
  await expect(deletedFile).toHaveAttribute("aria-selected", "true");
  await expect(deletedFile).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByText("Copy path")).toBeVisible();
  await page.keyboard.press("Escape");

  await longPressFileHeader(page, firstFile);
  await expect(firstFile).toHaveAttribute("aria-selected", "true");
  await expect(deletedFile).toHaveAttribute("aria-selected", "false");
  await expect(firstFile).toHaveAttribute("aria-expanded", "true");
});

test("every interactive file header has the same hover feedback", async ({ page }) => {
  const workspace = await createWorkspaceWithMountedTabDiff({ includeDeletedFile: true });
  await useUnwrappedDiffLines(page);
  await openWorkspaceChanges(page, workspace);

  const first = page.getByTestId("diff-file-0-toggle");
  const second = page.getByTestId("diff-file-1-toggle");
  const firstCanvas = page.getByTestId("git-diff-sticky-header-0");
  const secondCanvas = page.getByTestId("git-diff-sticky-header-1");
  const normalBackground = await headerCanvasPixel(firstCanvas, first, 10);

  await first.hover();
  await expect.poll(() => headerCanvasPixel(firstCanvas, first, 10)).not.toBe(normalBackground);
  const hoverBackground = await headerCanvasPixel(firstCanvas, first, 10);

  await first.click();
  await page.mouse.move(0, 0);
  await expect(first).toHaveAttribute("aria-expanded", "false");
  await expect.poll(() => headerCanvasPixel(firstCanvas, first, 10)).toBe(normalBackground);

  await first.hover();
  await expect.poll(() => headerCanvasPixel(firstCanvas, first, 10)).toBe(hoverBackground);
  await second.hover();
  await expect.poll(() => headerCanvasPixel(firstCanvas, first, 10)).toBe(normalBackground);
  await expect.poll(() => headerCanvasPixel(secondCanvas, second, 10)).toBe(hoverBackground);
});

test("horizontal body scrolling never moves or repaints the canvas header", async ({ page }) => {
  const wideLine = `export const wide = "${"wide".repeat(160)}";`;
  const workspace = await createWorkspaceWithExactSelectionDiff(wideLine);
  await useUnwrappedDiffLines(page);
  await openSelectionWorkspaceChanges(page, workspace);

  const headerCanvas = page.getByTestId("git-diff-canvas");
  const header = page.getByTestId("diff-file-0-toggle");
  const beforePixel = await headerCanvasPixel(headerCanvas, header, 10);
  const beforeBounds = await header.boundingBox();

  await horizontallyScrollFirstFile(page, 320);
  await page.waitForTimeout(50);

  expect(await headerCanvasPixel(headerCanvas, header, 10)).toBe(beforePixel);
  expect(await header.boundingBox()).toEqual(beforeBounds);
});

test("in-flow file headers move with the diff document", async ({ page }) => {
  const workspace = await createWorkspaceWithStickyTransitionDiff();
  await useUnwrappedDiffLines(page);
  await openWorkspaceChangesSurface(page, workspace);

  const motion = await measureInFlowHeaderMotion(page);

  expect(motion).toEqual({ headerSurface: -120, shell: -120 });
});

test("the outgoing sticky header hands off without a gap or overlap", async ({
  page,
}, testInfo) => {
  const workspace = await createWorkspaceWithStickyTransitionDiff();
  await useUnwrappedDiffLines(page);
  await openWorkspaceChangesSurface(page, workspace);

  const scroller = page.getByTestId("git-diff-scroll");
  const first = page.getByTestId("diff-file-0-toggle");
  const second = page.getByTestId("diff-file-1-toggle");
  const secondTop = await second.evaluate((element) => {
    const scrollElement = element.closest<HTMLElement>('[data-testid="git-diff-scroll"]');
    if (!scrollElement) return Number.NaN;
    return (
      scrollElement.scrollTop +
      element.getBoundingClientRect().top -
      scrollElement.getBoundingClientRect().top
    );
  });
  expect(secondTop).toBeGreaterThan(30);
  await scroller.evaluate((element, scrollTop) => {
    element.scrollTop = scrollTop;
    element.dispatchEvent(new Event("scroll", { bubbles: false }));
  }, secondTop - 15);
  await expect(first).toBeAttached();
  await expect(second).toBeAttached();

  const [scrollBounds, firstBounds, secondBounds] = await Promise.all([
    scroller.boundingBox(),
    first.boundingBox(),
    second.boundingBox(),
  ]);
  if (!scrollBounds || !firstBounds || !secondBounds) {
    throw new Error("Sticky transition geometry is unavailable");
  }
  expect(firstBounds.y - scrollBounds.y).toBeCloseTo(-15, 0);
  expect(secondBounds.y - scrollBounds.y).toBeCloseTo(15, 0);
  const transitionHits = await scroller.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return [14, 16].map(
      (y) =>
        document
          .elementFromPoint(bounds.left + bounds.width / 2, bounds.top + y)
          ?.closest<HTMLElement>("[data-diff-header]")?.dataset.diffHeaderPath ?? null,
    );
  });
  expect(transitionHits).toEqual(["src/first.ts", "src/second.ts"]);
  await testInfo.attach("canvas-header-sticky-handoff", {
    body: await page.getByTestId("git-diff-canvas-root").screenshot(),
    contentType: "image/png",
  });

  await scroller.evaluate((element, scrollTop) => {
    element.scrollTop = scrollTop;
    element.dispatchEvent(new Event("scroll", { bubbles: false }));
  }, secondTop);
  await expect
    .poll(async () => {
      const bounds = await second.boundingBox();
      return bounds ? bounds.y - scrollBounds.y : Number.NaN;
    })
    .toBeCloseTo(0, 0);
});

test("changes context menus duplicate files and folders", async ({ page }) => {
  const workspace = await createWorkspaceWithMountedTabDiff();
  await useUnwrappedDiffLines(page);
  await openWorkspaceChanges(page, workspace);

  await page.getByTestId("diff-file-0-toggle").click({ button: "right" });
  await page.getByTestId("diff-file-0-duplicate").click();
  await expect
    .poll(() => readFileIfPresent(path.join(workspace.repoPath, "src/use-mounted-tab-set copy.ts")))
    .toBe(AFTER);

  await changesTree(page).getByTestId("diff-folder-src-toggle").click({ button: "right" });
  await page.getByTestId("diff-folder-src-duplicate").click();
  await expect
    .poll(() => readFileIfPresent(path.join(workspace.repoPath, "src copy/use-mounted-tab-set.ts")))
    .toBe(AFTER);
});

test("changes tree aligns every file status after its diff stat", async ({ page }) => {
  const workspace = await createWorkspaceWithMountedTabDiff({
    includeDeletedFile: true,
    includeUntrackedFile: true,
  });
  await useUnwrappedDiffLines(page);
  await openWorkspaceChanges(page, workspace);
  const tree = changesTree(page);
  const modifiedRow = tree.getByTestId("diff-tree-file-0");
  const deletedRow = tree.getByTestId("diff-tree-file-1");
  const addedRow = tree.getByTestId("diff-tree-file-2");
  const modifiedStatus = modifiedRow.getByRole("img", { name: "Modified" });
  await expect(modifiedStatus).toBeVisible();
  await expect(deletedRow.getByRole("img", { name: "Deleted" })).toBeVisible();
  await expect(addedRow.getByRole("img", { name: "New" })).toBeVisible();

  const [statBounds, statusBounds] = await Promise.all([
    modifiedRow.getByTestId("diff-tree-file-0-stat").boundingBox(),
    modifiedStatus.boundingBox(),
  ]);
  if (!statBounds || !statusBounds) throw new Error("Changes tree trailing status has no bounds");
  expect(statusBounds.x - (statBounds.x + statBounds.width)).toBeGreaterThanOrEqual(8);
});

test("the scrolling diff lists files in changes tree order", async ({ page }) => {
  const workspace = await createWorkspaceWithMountedTabDiff({
    includeNestedFolders: true,
    includeRootFileSortingFirst: true,
  });
  await useUnwrappedDiffLines(page);
  await openWorkspaceChanges(page, workspace);

  const tree = changesTree(page);
  const treeNames = tree.locator('[data-testid^="diff-tree-file-"][data-testid$="-name"]');
  const panel = page.getByTestId("working-diff-panel").filter({ visible: true });
  const diffHeaders = panel.getByTestId(/^diff-file-\d+$/);

  // Directories sort before files at every level, so the root note lands last
  // even though "a-root-note.txt" compares below "src/..." as a whole string.
  const expected = ["changed.ts", "root.ts", "use-mounted-tab-set.ts", "a-root-note.txt"];

  // Equal counts also prove no folder is collapsed: flattenDiffTree drops the
  // descendants of a collapsed folder, which would make the tree a subsequence
  // of the diff rather than a match, and mask a real ordering difference.
  await expect(treeNames).toHaveCount(expected.length);
  await expect(diffHeaders).toHaveCount(expected.length);
  await expect(treeNames).toHaveText(expected);
  const expectedHeaderNames = [
    "src/zz-folder/nested/changed.ts, +1, -1",
    "src/zz-folder/root.ts, +1, -1",
    "src/use-mounted-tab-set.ts, +37, -1",
    "a-root-note.txt, +1, -0",
  ];
  for (const [index, accessibleName] of expectedHeaderNames.entries()) {
    await expect(diffHeaders.nth(index)).toHaveAccessibleName(accessibleName);
  }
});

test("changes context menu recursively collapses descendant folders", async ({ page }) => {
  const workspace = await createWorkspaceWithMountedTabDiff({ includeNestedFolders: true });
  await useUnwrappedDiffLines(page);
  await openWorkspaceChanges(page, workspace);

  const tree = changesTree(page);
  await expect(tree.getByTestId("diff-folder-src/zz-folder")).toBeVisible();
  await expect(tree.getByTestId("diff-folder-src/zz-folder/nested")).toBeVisible();
  const rootRow = tree.getByTestId("diff-folder-src-toggle");
  const rootLabel = tree.getByTestId("diff-folder-src-toggle").getByText("src", { exact: true });
  await expect(rootRow).toHaveCSS("opacity", "1");
  await expect(rootLabel).toHaveCSS("opacity", "0.76");
  await rootRow.hover();
  await expect(rootLabel).toHaveCSS("opacity", "1");
  await page.mouse.move(0, 0);
  const nestedLabel = tree
    .getByTestId("diff-folder-src/zz-folder-toggle")
    .getByText("zz-folder", { exact: true });
  const [rootBounds, nestedBounds] = await Promise.all([
    rootLabel.boundingBox(),
    nestedLabel.boundingBox(),
  ]);
  if (!rootBounds || !nestedBounds) throw new Error("Changes tree rows have no bounds");
  expect(nestedBounds.x - rootBounds.x).toBe(12);

  await tree.getByTestId("diff-folder-src-toggle").click({ button: "right" });
  await page.getByTestId("diff-folder-src-collapse-folder").click();
  await expect(tree.getByTestId("diff-folder-src/zz-folder")).toHaveCount(0);

  await tree.getByTestId("diff-folder-src-toggle").click();
  await expect(tree.getByTestId("diff-folder-src/zz-folder")).toBeVisible();
  await expect(tree.getByText("root.ts", { exact: true })).toHaveCount(0);

  await tree.getByTestId("diff-folder-src/zz-folder-toggle").click();
  await expect(tree.getByText("root.ts", { exact: true })).toBeVisible();
  await expect(tree.getByTestId("diff-folder-src/zz-folder/nested")).toBeVisible();
  await expect(tree.getByText("changed.ts", { exact: true })).toHaveCount(0);

  await tree.getByTestId("diff-folder-src/zz-folder/nested-toggle").click();
  await expect(tree.getByText("changed.ts", { exact: true })).toBeVisible();
});

test("legacy Git host: changes context menus expose folder revert and restore a file after confirmation", async ({
  page,
}) => {
  await useLegacyGitSurface(page);
  const workspace = await createWorkspaceWithMountedTabDiff();
  await useUnwrappedDiffLines(page);
  await openWorkspaceChanges(page, workspace);
  await selectChangesComparison(page, "Uncommitted");

  const tree = changesTree(page);
  await tree.getByTestId("diff-folder-src-toggle").click({ button: "right" });
  const folderRevert = page.getByTestId("diff-folder-src-revert");
  await expect(folderRevert).toBeVisible();
  const revertLabelColor = await folderRevert
    .getByText("Discard changes", { exact: true })
    .evaluate((element) => getComputedStyle(element).color);
  await expect(folderRevert.locator("svg")).toHaveCSS("stroke", revertLabelColor);
  await page.keyboard.press("Escape");

  await tree.getByTestId("diff-tree-file-0-toggle").click({ button: "right" });
  const cancelledConfirmation = new Promise<string>((resolve) => {
    page.once("dialog", async (dialog) => {
      const message = dialog.message();
      await dialog.dismiss();
      resolve(message);
    });
  });
  await page.getByTestId("diff-tree-file-0-revert").click();
  expect(await cancelledConfirmation).toContain("src/use-mounted-tab-set.ts");
  await expect(tree.getByTestId("diff-tree-file-0")).toBeVisible();
  await expect
    .poll(() => readFile(path.join(workspace.repoPath, "src/use-mounted-tab-set.ts"), "utf8"))
    .toBe(AFTER);

  await tree.getByTestId("diff-tree-file-0-toggle").click({ button: "right" });
  const confirmation = new Promise<string>((resolve) => {
    page.once("dialog", async (dialog) => {
      const message = dialog.message();
      await dialog.accept();
      resolve(message);
    });
  });
  await page.getByTestId("diff-tree-file-0-revert").click();
  expect(await confirmation).toContain("src/use-mounted-tab-set.ts");

  await expect(tree.getByTestId("diff-tree-file-0")).toHaveCount(0, { timeout: 30_000 });
  await expect
    .poll(() => readFile(path.join(workspace.repoPath, "src/use-mounted-tab-set.ts"), "utf8"))
    .toBe(BEFORE);
});

test("legacy Git host: discarding a staged rename restores its source path", async ({ page }) => {
  await useLegacyGitSurface(page);
  const workspace = await createWorkspaceWithMountedTabDiff({ includeRenamedFile: true });
  await useUnwrappedDiffLines(page);
  await openWorkspaceChanges(page, workspace);
  await selectChangesComparison(page, "Uncommitted");

  const panel = page.getByTestId("working-diff-panel").filter({ visible: true });
  const renamedHeader = diffHeaderForPath(panel, "src/zz-renamed.ts");
  await expect(renamedHeader).toHaveAccessibleName("src/zz-renamed.ts, +0, -0");
  const renamedToggle = renamedHeader.getByTestId(/^diff-file-\d+-toggle$/);
  const toggleTestId = await renamedToggle.getAttribute("data-testid");
  expect(toggleTestId).not.toBeNull();
  const rowTestId = toggleTestId!.slice(0, -"-toggle".length);
  await renamedToggle.click({ button: "right" });
  const confirmation = new Promise<void>((resolve) => {
    page.once("dialog", async (dialog) => {
      await dialog.accept();
      resolve();
    });
  });
  await page.getByTestId(`${rowTestId}-revert`).click();
  await confirmation;

  await expect(page.getByText("zz-renamed.ts", { exact: true })).toHaveCount(0, {
    timeout: 30_000,
  });
  await expect
    .poll(() => readFile(path.join(workspace.repoPath, "src/rename-source.ts"), "utf8"))
    .toBe("export const renamed = true;\n");
});

test("legacy Git host: discarding an untracked file removes it from the working tree", async ({
  page,
}) => {
  await useLegacyGitSurface(page);
  const workspace = await createWorkspaceWithMountedTabDiff({ includeUntrackedFile: true });
  await useUnwrappedDiffLines(page);
  await openWorkspaceChanges(page, workspace);
  await selectChangesComparison(page, "Uncommitted");

  const panel = page.getByTestId("working-diff-panel").filter({ visible: true });
  const untrackedHeader = diffHeaderForPath(panel, "zz-untracked.txt");
  await expect(untrackedHeader).toHaveAccessibleName("zz-untracked.txt, +1, -0");
  const untrackedToggle = untrackedHeader.getByTestId(/^diff-file-\d+-toggle$/);
  const toggleTestId = await untrackedToggle.getAttribute("data-testid");
  expect(toggleTestId).not.toBeNull();
  const rowTestId = toggleTestId!.slice(0, -"-toggle".length);
  await untrackedToggle.click({ button: "right" });
  const confirmation = new Promise<void>((resolve) => {
    page.once("dialog", async (dialog) => {
      await dialog.accept();
      resolve();
    });
  });
  await page.getByTestId(`${rowTestId}-revert`).click();
  await confirmation;

  await expect(page.getByText("zz-untracked.txt", { exact: true })).toHaveCount(0, {
    timeout: 30_000,
  });
  await expect(
    readFile(path.join(workspace.repoPath, "zz-untracked.txt"), "utf8"),
  ).rejects.toThrow();
});

test("legacy Git host: shows a revert error returned by the daemon", async ({ page }) => {
  const workspace = await createWorkspaceWithMountedTabDiff();
  await failNextDiscardRequest(page);
  await useUnwrappedDiffLines(page);
  await openWorkspaceChanges(page, workspace);
  await selectChangesComparison(page, "Uncommitted");

  await page.getByTestId("diff-file-0-toggle").click({ button: "right" });
  const confirmation = new Promise<void>((resolve) => {
    page.once("dialog", async (dialog) => {
      await dialog.accept();
      resolve();
    });
  });
  await page.getByTestId("diff-file-0-revert").click();
  await confirmation;

  await expect(page.getByText("Injected revert failure", { exact: true })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByTestId("diff-file-0")).toBeVisible();
  await expect
    .poll(() => readFile(path.join(workspace.repoPath, "src/use-mounted-tab-set.ts"), "utf8"))
    .toBe(AFTER);
});

test("legacy Git host: Changes keeps review navigation and controls inside its workspace tab", async ({
  page,
}) => {
  await useLegacyGitSurface(page);
  const workspace = await createWorkspaceWithMountedTabDiff({ includeDeletedFile: true });
  await useUnwrappedDiffLines(page);
  await openWorkspaceChanges(page, workspace);

  const visiblePanel = page.getByTestId("working-diff-panel").filter({ visible: true });
  await expect(visiblePanel).toBeVisible();
  await expect(visiblePanel.getByTestId("changes-repository-header")).toHaveCount(0);
  await expect(visiblePanel.getByTestId("changes-branch-switcher")).toHaveCount(0);
  const panelComparison = visiblePanel.getByTestId("changes-comparison-trigger");
  const treeComparison = page
    .getByTestId("changes-tree-panel")
    .filter({ visible: true })
    .getByTestId("changes-comparison-trigger");
  await expect(panelComparison).toBeVisible();
  await expect
    .poll(
      async () => (await panelComparison.textContent()) === (await treeComparison.textContent()),
    )
    .toBe(true);
  await expect(visiblePanel.getByTestId("changes-selected-diff-stat")).toHaveCount(0);
  await expect(visiblePanel.getByTestId("changes-header")).toHaveCount(1);
  await expect(diffHeaderForPath(visiblePanel, "src/use-mounted-tab-set.ts")).toHaveAccessibleName(
    "src/use-mounted-tab-set.ts, +37, -1",
  );
  await expect(diffHeaderForPath(visiblePanel, "src/zz-deleted.ts")).toHaveAccessibleName(
    "src/zz-deleted.ts, +0, -1",
  );
  await expect(visiblePanel.getByTestId("changes-primary-cta")).toHaveCount(0);
  await expect(page.getByTestId("changes-primary-cta")).toHaveCount(1);
  await expect(page.getByTestId("changes-primary-cta")).toContainText("Commit");
  await expect(visiblePanel.getByTestId("diff-file-0-body")).toBeVisible();
  await visiblePanel.getByTestId("diff-file-0-toggle").click();
  await expect(visiblePanel.getByTestId("diff-file-0-body")).not.toBeVisible();

  await expect(visiblePanel.getByRole("button", { name: "Diff options" })).toHaveCount(0);
  await expect(page.getByTestId("changes-open-tab")).toHaveCount(0);
  const collapseFiles = visiblePanel.getByTestId("changes-toggle-collapse-all");
  await expect(collapseFiles).toHaveAttribute("aria-label", "Collapse all files");
  await collapseFiles.click();
  await expect(collapseFiles).toHaveAttribute("aria-label", "Expand all files");
  await collapseFiles.click();
  await expect(visiblePanel.getByTestId("diff-file-0-body")).toBeVisible();

  const layout = visiblePanel.getByTestId("changes-toggle-layout");
  await expect(layout).toHaveAttribute("aria-label", "Switch to side-by-side diff");
  await layout.click();
  await expect(layout).toHaveAttribute("aria-label", "Switch to unified diff");

  const whitespace = visiblePanel.getByTestId("changes-toggle-whitespace");
  await expect(whitespace).toHaveAttribute("aria-label", "Hide whitespace");
  const wrapLines = visiblePanel.getByTestId("changes-toggle-wrap-lines");
  await expect(wrapLines).toHaveAttribute("aria-label", "Wrap long lines");
  await expect(visiblePanel.getByTestId("changes-refresh")).toHaveAttribute(
    "aria-label",
    "Refresh",
  );
  await wrapLines.click();
  await expect(wrapLines).toHaveAttribute("aria-label", "Scroll long lines");
  await expect(page.getByTestId(/^workspace-working-diff-close-/)).toHaveCount(1);

  await writeFile(path.join(workspace.repoPath, "src/use-mounted-tab-set.ts"), BEFORE);
  await expect(
    visiblePanel.locator('[data-diff-header-path="src/use-mounted-tab-set.ts"]'),
  ).toHaveCount(0, { timeout: 30_000 });
  await expect(visiblePanel.locator('[data-diff-header-path="src/zz-deleted.ts"]')).toBeVisible();
  await writeFile(path.join(workspace.repoPath, "src/use-mounted-tab-set.ts"), AFTER);
  await expect(diffHeaderForPath(visiblePanel, "src/use-mounted-tab-set.ts")).toHaveAccessibleName(
    "src/use-mounted-tab-set.ts, +37, -1",
    { timeout: 30_000 },
  );
  await expect(diffHeaderForPath(visiblePanel, "src/zz-deleted.ts")).toHaveAccessibleName(
    "src/zz-deleted.ts, +0, -1",
  );
});

test("legacy Git host: compact Changes keeps its actions compact and menu-only", async ({
  page,
}) => {
  await useLegacyGitSurface(page);
  const workspace = await createWorkspaceWithMountedTabDiff();
  await useUnwrappedDiffLines(page);
  await openWorkspaceChanges(page, workspace);
  await page.setViewportSize({ width: 480, height: 900 });
  // The shell survives the breakpoint, so the wide Explorer can still be on screen right after the
  // resize. Check for the compact tab only once the shell reports the compact layout.
  await expect(page.getByTestId("compact-shell")).toBeVisible();

  const compactChangesTab = page
    .getByTestId("workspace-tab-changes_tree")
    .filter({ visible: true });
  if (!(await compactChangesTab.isVisible())) {
    await page.getByTestId("workspace-explorer-toggle").first().click();
  }
  await expect(compactChangesTab).toBeVisible();
  await compactChangesTab.click();
  const compactExplorer = page.getByTestId("workspace-explorer-sidebar").filter({ visible: true });
  await expect(compactExplorer.getByTestId("changes-header")).toBeVisible();

  const actions = compactExplorer.getByTestId("changes-actions-menu-trigger");
  const options = compactExplorer.getByRole("button", { name: "Diff options" });
  const [actionsBox, optionsBox, glyphBox] = await Promise.all([
    actions.boundingBox(),
    options.boundingBox(),
    options.locator("svg").boundingBox(),
  ]);
  if (!actionsBox || !optionsBox || !glyphBox) {
    throw new Error("Compact Changes toolbar geometry could not be measured");
  }
  expect(actionsBox.width).toBe(48);
  expect(actionsBox.height).toBe(28);
  expect(optionsBox.width).toBe(32);
  expect(optionsBox.height).toBe(32);
  expect(glyphBox.width).toBe(18);
  expect(glyphBox.height).toBe(18);

  await expect(actions).not.toContainText("Commit");
  await expect(actions.locator("svg")).toHaveCount(2);
  await actions.click();
  await expect(page.getByTestId("changes-primary-cta-menu")).toBeVisible();
  await expect(page.getByTestId("changes-menu-commit")).toContainText("Commit");
  await page.keyboard.press("Escape");

  await options.click();
  const wrapLines = page.getByText("Wrap long lines", { exact: true });
  await expect(wrapLines).toBeVisible();
  await wrapLines.click();
  await options.click();
  await expect(
    page.getByTestId("changes-options-menu-content").getByTestId("changes-toggle-wrap-lines"),
  ).toContainText("Scroll long lines");
});

test("legacy Git host: compact Explorer renders inline hunks with a saved tree-only desktop preference", async ({
  page,
}) => {
  await useLegacyGitSurface(page);
  const workspace = await createWorkspaceWithMountedTabDiff();
  await page.addInitScript(
    ({ key }) => {
      localStorage.setItem(key, JSON.stringify({ inlineDiff: false, layout: "split" }));
    },
    { key: CHANGES_PREFERENCES_KEY },
  );
  const explorer = await openCompactChanges(page, workspace);
  await selectChangesComparison(page, "Uncommitted");
  await expect(explorer.getByTestId("git-diff-canvas")).toBeVisible();
  await expect(explorer.getByTestId("diff-file-0-toggle")).toBeVisible();
  await explorer.getByTestId("diff-file-0-toggle").click({ button: "right" });
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByTestId("diff-file-0-revert").click();
  await expect
    .poll(() => readFile(path.join(workspace.repoPath, "src/use-mounted-tab-set.ts"), "utf8"))
    .toBe(BEFORE);
});

test("legacy Git host: compact Changes jumps to a file from the changed-files sheet", async ({
  page,
}) => {
  await useLegacyGitSurface(page);
  const workspace = await createWorkspaceWithMountedTabDiff({ includeNestedFolders: true });
  await useUnwrappedDiffLines(page);
  const explorer = await openCompactChanges(page, workspace);

  await openChangedFilesOverview(page);
  await test.step("reopening the overview expands folders again", async () => {
    await expectOverviewReopensExpanded(page, "zz-folder", "changed.ts");
  });
  await test.step("jumping to a nested file closes the overview and scrolls to its diff", async () => {
    await jumpToOverviewFile(page, explorer, "src/zz-folder/nested/changed.ts");
  });
});

test("legacy Git host: Jump to file stays out of the desktop diff and of an empty comparison", async ({
  page,
}) => {
  await useLegacyGitSurface(page);
  const committed = await createWorkspaceWithCommittedDiff();
  await openWorkspaceChangesSurface(page, committed, 90_000);
  await expect(page.getByRole("button", { name: "Jump to file" })).toHaveCount(0);

  const explorer = await openCompactChanges(page, committed);
  await expect(explorer.getByRole("button", { name: "Jump to file" })).toBeVisible();

  await selectEmptyUncommittedComparison(page, explorer);
  await expect(page.getByRole("button", { name: "Jump to file" })).toHaveCount(0);
});

test("canvas diff stays sharp while its workspace pane is resized", async ({ page }) => {
  const workspace = await createWorkspaceWithMountedTabDiff();
  await useUnwrappedDiffLines(page);
  await openWorkspaceChanges(page, workspace);

  const canvas = page.getByTestId("git-diff-canvas");
  const root = page.getByTestId("git-diff-canvas-root");
  const handle = page
    .getByTestId("workspace-explorer-sidebar-resize-handle")
    .getByRole("separator");
  await expect(handle).toBeVisible();
  await expect
    .poll(async () => {
      const [canvasWidth, rootWidth] = await Promise.all([
        canvas.evaluate((element) => (element as HTMLCanvasElement).getBoundingClientRect().width),
        root.evaluate((element) => element.getBoundingClientRect().width),
      ]);
      return Math.abs(canvasWidth - rootWidth) < 1;
    })
    .toBe(true);
  const [handleBounds, before] = await Promise.all([
    handle.boundingBox(),
    canvas.evaluate((element) => {
      const canvasElement = element as HTMLCanvasElement;
      return {
        width: canvasElement.getBoundingClientRect().width,
        ratio: window.devicePixelRatio || 1,
      };
    }),
  ]);
  if (!handleBounds) throw new Error("Explorer sidebar resize handle has no bounds");

  await page.mouse.move(handleBounds.x + handleBounds.width / 2, handleBounds.y + 120);
  await page.mouse.down();
  await page.mouse.move(handleBounds.x + 120, handleBounds.y + 120);
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));

  const duringDrag = await Promise.all([
    canvas.evaluate((element) => (element as HTMLCanvasElement).getBoundingClientRect().width),
    root.evaluate((element) => element.getBoundingClientRect().width),
  ]);
  expect(duringDrag[0]).toBeCloseTo(before.width, 0);
  expect(duringDrag[1]).toBeGreaterThan(before.width + 10);

  await page.mouse.up();
  const resizeFrames = await page.evaluate(async () => {
    const canvasElement = document.querySelector<HTMLCanvasElement>(
      '[data-testid="git-diff-canvas"]',
    )!;
    const ratio = window.devicePixelRatio || 1;
    const frames: Array<{ cssWidth: number; bitmapWidth: number }> = [];
    for (let index = 0; index < 10; index += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      frames.push({
        cssWidth: canvasElement.getBoundingClientRect().width,
        bitmapWidth: canvasElement.width / ratio,
      });
    }
    return frames;
  });
  for (const frame of resizeFrames) {
    expect(Math.abs(frame.cssWidth - frame.bitmapWidth)).toBeLessThan(1);
  }
  await expect
    .poll(async () => {
      const [canvasWidth, rootWidth, backingWidth] = await Promise.all([
        canvas.evaluate((element) => (element as HTMLCanvasElement).getBoundingClientRect().width),
        root.evaluate((element) => element.getBoundingClientRect().width),
        canvas.evaluate((element) => (element as HTMLCanvasElement).width),
      ]);
      return (
        Math.abs(canvasWidth - rootWidth) < 1 &&
        Math.abs(backingWidth / before.ratio - rootWidth) < 1
      );
    })
    .toBe(true);
});

test("changes diff waits for configured fonts, then applies code typography changes", async ({
  page,
}) => {
  const workspace = await createWorkspaceWithMountedTabDiff();
  await useCodeFont(page, 12);
  await useUnwrappedDiffLines(page);
  await holdBrowserFontLoads(page);
  await navigateToWorkspaceChanges(page, workspace);

  await test.step("commit no geometry before the configured fonts are ready", async () => {
    await expect(page.getByTestId("git-diff-canvas")).toBeVisible();
    await expect(page.getByTestId("diff-file-0-body")).toHaveCount(0);
    await releaseBrowserFontLoads(page);
    await expectExpandedMountedTabDiff(page);
  });
  const before = await readDiffTypographyGeometry(page);

  await changeCodeTypographyFromSettings(page, {
    fontSize: 18,
    fontFamily: "Courier New, Courier, monospace",
  });
  await returnToWorkspaceChanges(page);
  await expectStoredCodeFontSize(page, 18);
  await scrollToLowerUnwrappedDiffRows(page);

  await expectDiffCodeFontSize(page, 18);
  await expectDiffCodeFontFamily(page, "Courier");
  await expectVisibleDiffRowsShareTypography(page);
  const after = await readDiffTypographyGeometry(page);
  expect(after.horizontalExtent).toBeGreaterThan(before.horizontalExtent);
  expect(after.canvasPixels).not.toEqual(before.canvasPixels);
});

test("creates, cancels, edits, and deletes a review while keeping Changes focused", async ({
  page,
}) => {
  const workspace = await createWorkspaceWithMountedTabDiff();
  await useUnwrappedDiffLines(page);
  await openWorkspaceChanges(page, workspace);
  const changesTab = page.getByTestId("workspace-tab-working_diff").filter({ visible: true });
  const focusedBackground = await changesTab.evaluate(
    (element) => getComputedStyle(element).backgroundColor,
  );

  await test.step("start a focused review with the browser text menu", async () => {
    await startReviewOnFirstChangedLine(page);
    await expect(page.getByTestId("inline-review-editor-input")).toBeFocused();
    await expect(changesTab).toHaveCSS("background-color", focusedBackground);
    await page.getByTestId("inline-review-editor-input").click({ button: "right" });
    await expect(page.getByTestId("diff-source-context-menu")).toHaveCount(0);
    await cancelInlineReview(page);
  });
  await test.step("save, edit, and delete the review", async () => {
    await startReviewOnFirstChangedLine(page);
    await saveInlineReview(page, "Please keep this branch explicit");
    await editInlineReview(page, "Please keep this branch named explicitly");
    await deleteInlineReview(page);
  });
});

test("split canvas creates a review on the changed side and keeps it in that column", async ({
  page,
}) => {
  const workspace = await createWorkspaceWithMountedTabDiff();
  await configureDiffPresentation(page, { layout: "split", wrapLines: false });
  await openWorkspaceChanges(page, workspace);
  await setOpenChangesPresentation(page, { layout: "split", wrapLines: false });
  await startReviewOnFirstChangedLine(page, "right");
  const [editor, body] = await Promise.all([
    page.getByTestId("inline-review-editor").boundingBox(),
    page.getByTestId("diff-file-0-body").boundingBox(),
  ]);
  expect(editor).not.toBeNull();
  expect(body).not.toBeNull();
  expect(editor!.x).toBeGreaterThanOrEqual(body!.x + body!.width / 2);
  await cancelInlineReview(page);
});

test("scrolling clears the hovered review affordance", async ({ page }) => {
  const workspace = await createWorkspaceWithMountedTabDiff();
  await useUnwrappedDiffLines(page);
  await openWorkspaceChanges(page, workspace);

  await hoverFirstChangedGutter(page);
  await expect(page.getByRole("button", { name: "Add review comment" })).toBeVisible();
  await page.getByTestId("git-diff-scroll").evaluate((element) => {
    element.scrollTop += 80;
    element.dispatchEvent(new Event("scroll", { bubbles: false }));
  });

  await expect(page.getByRole("button", { name: "Add review comment" })).toHaveCount(0);
});

test("canvas diff uses the overlay scrollbar and its thumb controls vertical scrolling", async ({
  page,
}) => {
  const lines = Array.from({ length: 240 }, (_, index) => `export const line${index} = ${index};`);
  const workspace = await createWorkspaceWithExactSelectionDiff(lines.join("\n"));
  await openSelectionWorkspaceChanges(page, workspace);

  const root = page.getByTestId("git-diff-canvas-root");
  const scroller = page.getByTestId("git-diff-scroll");
  const grab = root.getByTestId("workspace-overlay-scrollbar-grab");
  await expect(grab).toBeVisible();
  await expect(scroller).toHaveCSS("scrollbar-width", "none");

  const bounds = await grab.boundingBox();
  if (!bounds) throw new Error("Diff overlay scrollbar thumb has no bounds");
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.mouse.down();
  await expect(grab).toHaveCSS("cursor", "grabbing");
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2 + 180);
  await page.mouse.up();

  await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
});

test("canvas headers keep a many-file diff bounded while scrolling end to end", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const workspace = await createWorkspaceWithManyTinyDiffs(2_000);
  await useUnwrappedDiffLines(page);
  await openWorkspaceChangesSurface(page, workspace, 90_000);

  const root = page.getByTestId("git-diff-canvas-root");
  const scroller = page.getByTestId("git-diff-scroll");
  await expect(root.locator('[data-testid^="git-diff-sticky-header-"]')).toHaveCount(2);
  await expect.poll(() => root.locator('[data-diff-header="true"]').count()).toBeLessThan(120);

  await scroller.evaluate((element) => {
    element.scrollTop = element.scrollHeight - element.clientHeight;
    element.dispatchEvent(new Event("scroll", { bubbles: false }));
  });

  await expect(page.getByTestId("diff-file-1999")).toBeVisible();
  await expect.poll(() => root.locator('[data-diff-header="true"]').count()).toBeLessThan(120);
  await expect(root.locator('[data-testid^="git-diff-sticky-header-"]')).toHaveCount(2);
});

test("the whole reviewable row reveals the gutter affordance and uses a text cursor", async ({
  page,
}) => {
  const workspace = await createWorkspaceWithMountedTabDiff();
  await useUnwrappedDiffLines(page);
  await openWorkspaceChanges(page, workspace);

  const body = page.getByTestId("diff-file-0-body");
  const canvas = page.getByTestId("git-diff-canvas");
  const [bodyBounds, fontSize] = await Promise.all([
    body.boundingBox(),
    canvas.evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize)),
  ]);
  if (!bodyBounds) throw new Error("Expanded diff body has no bounds");
  const lineHeight = Math.round(fontSize * 1.5);
  await page.mouse.move(bodyBounds.x + bodyBounds.width - 32, bodyBounds.y + lineHeight * 1.5);

  const affordance = page.getByRole("button", { name: "Add review comment" });
  await expect(affordance).toBeVisible();
  await expect(affordance.locator("svg")).toBeVisible();
  const affordanceBounds = await affordance.boundingBox();
  expect(affordanceBounds?.width).toBeCloseTo(22, 0);
  expect(affordanceBounds?.height).toBeCloseTo(22, 0);
  await expect(affordance).not.toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(page.getByTestId("git-diff-scroll")).toHaveCSS("cursor", "text");
});

test("selects, preserves, copies, and dismisses diff text without opening a review", async ({
  page,
}) => {
  await openCopyableSelectionDiff(page, "ABCDEFGHIJ");
  await dragExactAddedText(page, { startOffset: 2, endOffset: 8 });

  await test.step("copy the selected characters with the keyboard", async () => {
    await copyDiffSelectionWithKeyboard(page);
    await expectClipboardText(page, "CDEFGH");
    await expect(page.getByTestId("inline-review-editor")).toHaveCount(0);
  });
  await test.step("copy the preserved selection after resizing", async () => {
    await resizeDiffViewportHeight(page, 960);
    await copyFromChangedLineMenu(page, "Copy");
    await expectClipboardText(page, "CDEFGH");
  });
  await test.step("copy the complete source line", async () => {
    await copyFromChangedLineMenu(page, "Copy line");
    await expectClipboardText(page, "ABCDEFGHIJ");
  });
  await test.step("dismiss a new selection without starting a review", async () => {
    await dragExactAddedText(page, { startOffset: 2, endOffset: 8 });
    await clickFirstChangedLine(page);
    await expect(page.getByTestId("inline-review-editor")).toHaveCount(0);
    await rightClickFirstChangedLine(page);
    await expect(page.getByTestId("diff-source-copy-selection")).toBeDisabled();
    await page.keyboard.press("Escape");
    await clickFirstChangedLine(page);
    await expect(page.getByTestId("inline-review-editor")).toHaveCount(0);
  });
});

test("canvas diff clears a selection when collapsing an earlier file", async ({ page }) => {
  const workspace = await createWorkspaceWithTwoSelectionDiffs();
  await useUnwrappedDiffLines(page);
  await openWorkspaceChanges(page, workspace);

  await dragExactAddedText(page, { startOffset: 2, endOffset: 8 }, 1);
  await page.getByTestId("diff-file-0-toggle").click();
  await rightClickFirstChangedLine(page, 1);
  await expect(page.getByTestId("diff-source-copy-selection")).toBeDisabled();
});

test("canvas diff replaces a selection with forward and backward drags", async ({
  context,
  page,
}) => {
  const workspace = await createWorkspaceWithExactSelectionDiff("ABCDE\nFGHIJ");
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await useUnwrappedDiffLines(page);
  await openSelectionWorkspaceChanges(page, workspace);
  for (const [start, end, expectedText] of [
    [{ line: 0, offset: 2 }, { line: 1, offset: 3 }, "CDE\nFGH"],
    [{ line: 1, offset: 5 }, { line: 0, offset: 3 }, "DE\nFGHIJ"],
  ] as const) {
    await dragAddedTextRange(page, { lines: ["ABCDE", "FGHIJ"], start, end });
    await page.keyboard.press("ControlOrMeta+C");
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(expectedText);
  }
});

test("canvas diff copies only the selected split side", async ({ context, page }) => {
  const lines = ["RIGHT-ONE", "RIGHT-TWO"];
  const workspace = await createWorkspaceWithExactSelectionDiff(lines.join("\n"));
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await configureDiffPresentation(page, { layout: "split", wrapLines: false });
  await openSelectionWorkspaceChanges(page, workspace);
  await setOpenChangesPresentation(page, { layout: "split", wrapLines: false });
  const before = await readSelectionPaintSamples(page, "right");
  await dragAddedTextRange(page, {
    lines,
    side: "right",
    start: { line: 0, offset: 1 },
    end: { line: 1, offset: 5 },
  });
  await page.keyboard.press("ControlOrMeta+C");
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe("IGHT-ONE\nRIGHT");
  const after = await readSelectionPaintSamples(page, "right");
  expect(after.gutter).toEqual(before.gutter);
  expect(after.opposite).toEqual(before.opposite);
  expect(after.code).not.toEqual(before.code);
});

test("canvas diff copies exact wrapped fragments", async ({ context, page }) => {
  const content = "abcdefghijklmnopqrstuvwxyz".repeat(8);
  const workspace = await createWorkspaceWithExactSelectionDiff(content);
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await configureDiffPresentation(page, { layout: "unified", wrapLines: true });
  await openSelectionWorkspaceChanges(page, workspace);
  await setOpenChangesPresentation(page, { layout: "unified", wrapLines: true });
  await dragAddedTextRange(page, {
    lines: [content],
    wrapped: true,
    start: { line: 0, offset: 35 },
    end: { line: 0, offset: 95 },
  });
  await page.keyboard.press("ControlOrMeta+C");
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe(content.slice(35, 95));
});

test("horizontally scrolled selection copies exactly and does not paint the gutter", async ({
  context,
  page,
}) => {
  const content = "0123456789".repeat(50);
  const workspace = await createWorkspaceWithExactSelectionDiff(content);
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await useUnwrappedDiffLines(page);
  await openSelectionWorkspaceChanges(page, workspace);
  const horizontalOffset = await horizontallyScrollFirstFile(page, 320);
  const before = await readSelectionPaintSamples(page);
  await dragAddedTextRange(page, {
    lines: [content],
    horizontalOffset,
    start: { line: 0, offset: 48 },
    end: { line: 0, offset: 58 },
  });
  await page.keyboard.press("ControlOrMeta+C");
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe(content.slice(48, 58));
  const after = await readSelectionPaintSamples(page);
  expect(after.gutter).toEqual(before.gutter);
  expect(after.code).not.toEqual(before.code);
});

test("dragging within one wide grapheme or outside its cell never opens a review", async ({
  page,
}) => {
  const workspace = await createWorkspaceWithExactSelectionDiff("👨‍👩‍👧‍👦tail");
  await useCodeFont(page, 40);
  await useUnwrappedDiffLines(page);
  await openSelectionWorkspaceChanges(page, workspace);

  await dragWithinFirstAddedGrapheme(page);
  await expect(page.getByTestId("inline-review-editor")).toHaveCount(0);

  await dragFirstAddedLineIntoHeader(page);
  await expect(page.getByTestId("inline-review-editor")).toHaveCount(0);

  const body = await page.getByTestId("diff-file-0-body").boundingBox();
  if (!body) throw new Error("Expanded diff body has no bounds");
  await page.mouse.click(body.x + 60, body.y + 90, { button: "right" });
  await expect(page.getByTestId("inline-review-editor")).toHaveCount(0);
});

test("collapsing and expanding restores the real horizontal scroll offset", async ({ page }) => {
  const workspace = await createWorkspaceWithExactSelectionDiff("x".repeat(400));
  await useUnwrappedDiffLines(page);
  await openSelectionWorkspaceChanges(page, workspace);

  const retainedOffset = await horizontallyScrollFirstFile(page, 320);
  await page.getByTestId("diff-file-0-toggle").click();
  await expect(page.getByTestId("diff-file-0-horizontal-scroll")).toHaveCount(0);
  await page.getByTestId("diff-file-0-toggle").click();

  await expect
    .poll(() =>
      page.getByTestId("diff-file-0-horizontal-scroll").evaluate((element) => element.scrollLeft),
    )
    .toBe(retainedOffset);
});

async function useCodeFont(page: Page, codeFontSize: number): Promise<void> {
  await page.addInitScript(
    ({ settingsKey, fontSize }) => {
      const settings = JSON.parse(localStorage.getItem(settingsKey) ?? "{}");
      if (settings.codeFontSize !== undefined) {
        return;
      }
      localStorage.setItem(
        settingsKey,
        JSON.stringify({
          ...settings,
          theme: "dark",
          sendBehavior: "interrupt",
          serviceUrlBehavior: "ask",
          terminalScrollbackLines: 10_000,
          uiFontFamily: "",
          monoFontFamily: "",
          uiFontSize: 16,
          codeFontSize: fontSize,
          syntaxTheme: "one",
        }),
      );
    },
    { settingsKey: APP_SETTINGS_KEY, fontSize: codeFontSize },
  );
}

async function useUnwrappedDiffLines(page: Page): Promise<void> {
  await configureDiffPresentation(page, { layout: "unified", wrapLines: false });
}

async function configureDiffPresentation(
  page: Page,
  requestedPresentation: { layout: "unified" | "split"; wrapLines: boolean; inlineDiff?: boolean },
): Promise<void> {
  await page.addInitScript(
    ({ preferencesKey, presentation }) => {
      localStorage.setItem(
        preferencesKey,
        JSON.stringify({
          layout: presentation.layout,
          desktopTreeVisible: false,
          inlineDiff: presentation.inlineDiff ?? false,
          wrapLines: presentation.wrapLines,
          hideWhitespace: false,
        }),
      );
    },
    { preferencesKey: CHANGES_PREFERENCES_KEY, presentation: requestedPresentation },
  );
}

async function setOpenChangesPresentation(
  page: Page,
  requestedPresentation: { layout: "unified" | "split"; wrapLines: boolean },
): Promise<void> {
  const diffPanel = page.getByTestId("working-diff-panel").filter({ visible: true });
  const layoutItem = diffPanel.getByTestId("changes-toggle-layout");
  const currentLayout =
    (await layoutItem.getAttribute("aria-label")) === "Switch to unified diff"
      ? "split"
      : "unified";
  if (currentLayout !== requestedPresentation.layout) {
    await layoutItem.click();
  }

  const wrapItem = diffPanel.getByTestId("changes-toggle-wrap-lines");
  const currentWrapLines = (await wrapItem.getAttribute("aria-label")) === "Scroll long lines";
  if (currentWrapLines !== requestedPresentation.wrapLines) {
    await wrapItem.click();
  }
}

/** Holds every font load in the document until released; later loads pass through. */
async function holdBrowserFontLoads(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const fontSet = document.fonts;
    const originalLoad = fontSet.load.bind(fontSet);
    const pending: Array<() => void> = [];
    let released = false;
    Object.defineProperty(fontSet, "load", {
      configurable: true,
      value(font: string, text?: string) {
        if (released) return originalLoad(font, text);
        return new Promise<FontFace[]>((resolve, reject) => {
          pending.push(() => {
            originalLoad(font, text).then(resolve, reject);
          });
        });
      },
    });
    Object.assign(window, {
      __releasePaseoDiffFontLoads() {
        released = true;
        for (const release of pending.splice(0)) release();
      },
    });
  });
}

async function releaseBrowserFontLoads(page: Page): Promise<void> {
  await page.evaluate(() => {
    (
      window as typeof window & { __releasePaseoDiffFontLoads: () => void }
    ).__releasePaseoDiffFontLoads();
  });
}

async function expectDiffCodeFontSize(page: Page, fontSize: number): Promise<void> {
  const canvas = page.getByTestId("git-diff-canvas");
  await expect
    .poll(async () => {
      return canvas.evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize));
    })
    .toBe(fontSize);
}

async function expectDiffCodeFontFamily(page: Page, fontFamily: string): Promise<void> {
  await expect
    .poll(() =>
      page
        .getByTestId("git-diff-canvas")
        .evaluate((element) => getComputedStyle(element).fontFamily),
    )
    .toContain(fontFamily);
}

async function expectVisibleDiffRowsShareTypography(page: Page): Promise<void> {
  await expect(page.getByTestId("git-diff-canvas")).toBeVisible();
  await expect(page.locator('[data-testid^="diff-code-row-"]')).toHaveCount(0);
}

async function createChangesRepo(
  prefix: string,
  options?: Parameters<typeof createTempGitRepo>[1],
) {
  const repo = await createTempGitRepo(prefix, options);
  configureTempComparisonBase(repo.path);
  return repo;
}

async function createWorkspaceWithMountedTabDiff(
  options: WorkspaceFixtureOptions = {},
): Promise<DirtyWorkspace> {
  const files = [{ path: "src/use-mounted-tab-set.ts", content: BEFORE }];
  if (options.includeDeletedFile) {
    files.push({ path: "src/zz-deleted.ts", content: "export const deleted = true;\n" });
  }
  if (options.includeRenamedFile) {
    files.push({ path: "src/rename-source.ts", content: "export const renamed = true;\n" });
  }
  if (options.includeNestedFolders) {
    files.push(
      { path: "src/zz-folder/root.ts", content: "export const root = 1;\n" },
      { path: "src/zz-folder/nested/changed.ts", content: "export const nested = 1;\n" },
    );
  }
  const repo = await createChangesRepo("changes-pane-", { files });
  const client = await connectSeedClient();
  cleanupTasks.push({
    run: async () => {
      await client.close().catch(() => undefined);
      await repo.cleanup().catch(() => undefined);
    },
  });

  await writeFile(path.join(repo.path, "src/use-mounted-tab-set.ts"), AFTER);
  if (options.includeUntrackedFile) {
    await writeFile(path.join(repo.path, "zz-untracked.txt"), "remove me\n");
  }
  if (options.includeRootFileSortingFirst) {
    await writeFile(path.join(repo.path, "a-root-note.txt"), "root note\n");
  }
  if (options.includeDeletedFile) {
    await unlink(path.join(repo.path, "src/zz-deleted.ts"));
  }
  if (options.includeRenamedFile) {
    execFileSync("git", ["mv", "src/rename-source.ts", "src/zz-renamed.ts"], {
      cwd: repo.path,
    });
  }
  if (options.includeNestedFolders) {
    await writeFile(path.join(repo.path, "src/zz-folder/root.ts"), "export const root = 2;\n");
    await writeFile(
      path.join(repo.path, "src/zz-folder/nested/changed.ts"),
      "export const nested = 2;\n",
    );
  }
  const createdWorkspace = await client.createWorkspace({
    source: { kind: "directory", path: repo.path },
  });
  if (!createdWorkspace.workspace) {
    throw new Error(createdWorkspace.error ?? `Failed to create workspace ${repo.path}`);
  }
  return { id: createdWorkspace.workspace.id, repoPath: repo.path };
}

async function createWorkspaceWithNetDiff(): Promise<DirtyWorkspace> {
  const repo = await createChangesRepo("changes-net-", {
    files: [{ path: "a-tracked.ts", content: "base\n" }],
  });
  const client = await connectSeedClient();
  cleanupTasks.push({
    run: async () => {
      await client.close();
      await repo.cleanup();
    },
  });
  execFileSync("git", ["checkout", "-b", "feature"], { cwd: repo.path });
  await writeFile(path.join(repo.path, "a-tracked.ts"), "committed\n");
  await writeFile(path.join(repo.path, "b-committed.ts"), "committed only\n");
  execFileSync("git", ["add", "--all"], { cwd: repo.path });
  execFileSync("git", ["commit", "-m", "Committed changes"], { cwd: repo.path });
  const created = await client.createWorkspace({ source: { kind: "directory", path: repo.path } });
  if (!created.workspace) throw new Error(created.error ?? "Failed to create net diff workspace");
  return { id: created.workspace.id, repoPath: repo.path };
}

async function expectNetComparisonFiles(page: Page, files: string[]): Promise<void> {
  const tree = page.getByTestId("changes-tree-panel").filter({ visible: true });
  const panel = page.getByTestId("working-diff-panel").filter({ visible: true });
  await expect(tree.locator('[data-testid^="diff-tree-file-"][data-testid$="-name"]')).toHaveText(
    files,
  );
  await expect(panel.getByTestId(/^diff-file-\d+$/)).toHaveCount(files.length);
  for (const file of files) {
    await expect(diffHeaderForPath(panel, file)).toBeVisible();
  }
}

async function expectRenderedAddedLine(page: Page, contents: string): Promise<void> {
  await changesTree(page).getByText("a-tracked.ts", { exact: true }).click();
  await expect(async () => {
    await page.keyboard.press("Escape");
    await page.evaluate(() => navigator.clipboard.writeText(""));
    const body = page.getByTestId("diff-file-0-body");
    const canvas = page.getByTestId("git-diff-canvas");
    const bounds = await body.boundingBox();
    if (!bounds) throw new Error("Expanded diff body has no bounds");
    const fontSize = await canvas.evaluate((element) =>
      Number.parseFloat(getComputedStyle(element).fontSize),
    );
    // Replacement: hunk header, removed line, added line.
    await page.mouse.click(bounds.x + 120, bounds.y + Math.round(fontSize * 1.5) * 2.5, {
      button: "right",
    });
    const copyLine = page.getByRole("menuitem", { name: "Copy line", exact: true });
    await expect(copyLine).toBeEnabled({ timeout: 1000 });
    await copyLine.click({ timeout: 1000 });
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()), { timeout: 1000 })
      .toBe(contents);
  }).toPass({ timeout: 15_000 });
}

async function createWorkspaceWithCommittedDiff(): Promise<DirtyWorkspace> {
  const repo = await createChangesRepo("changes-committed-", {
    files: [{ path: "tracked.ts", content: "export const tracked = 1;\n" }],
  });
  const client = await connectSeedClient();
  cleanupTasks.push({
    run: async () => {
      await client.close().catch(() => undefined);
      await repo.cleanup().catch(() => undefined);
    },
  });

  execFileSync("git", ["checkout", "-b", "feature"], { cwd: repo.path });
  await writeFile(path.join(repo.path, "committed-only.ts"), "export const committed = true;\n");
  execFileSync("git", ["add", "committed-only.ts"], { cwd: repo.path });
  execFileSync("git", ["commit", "-m", "Add committed-only file"], { cwd: repo.path });

  const created = await client.createWorkspace({ source: { kind: "directory", path: repo.path } });
  if (!created.workspace) throw new Error(created.error ?? "Failed to create committed workspace");
  return { id: created.workspace.id, repoPath: repo.path };
}

async function createWorkspaceWithScrollableComparisons(): Promise<DirtyWorkspace> {
  const repo = await createChangesRepo("changes-comparison-focus-", {
    files: [{ path: "tracked.ts", content: "export const tracked = true;\n" }],
  });
  const client = await connectSeedClient();
  cleanupTasks.push({
    run: async () => {
      await client.close().catch(() => undefined);
      await repo.cleanup().catch(() => undefined);
    },
  });

  const longFile = Array.from(
    { length: 120 },
    (_, index) => `export const line${index} = ${index};`,
  ).join("\n");
  execFileSync("git", ["checkout", "-b", "feature"], { cwd: repo.path });
  await writeComparisonFiles(repo.path, "committed", longFile);
  execFileSync("git", ["add", "committed"], { cwd: repo.path });
  execFileSync("git", ["commit", "-m", "Add committed comparison files"], { cwd: repo.path });
  await writeComparisonFiles(repo.path, "uncommitted", longFile);

  const created = await client.createWorkspace({ source: { kind: "directory", path: repo.path } });
  if (!created.workspace) throw new Error(created.error ?? "Failed to create comparison workspace");
  return { id: created.workspace.id, repoPath: repo.path };
}

async function writeComparisonFiles(
  repoPath: string,
  directory: "committed" | "uncommitted",
  longFile: string,
): Promise<void> {
  await mkdir(path.join(repoPath, directory), { recursive: true });
  await Promise.all([
    writeFile(path.join(repoPath, directory, "00-before.ts"), `${longFile}\n`),
    writeFile(path.join(repoPath, directory, "50-target.ts"), "export const target = true;\n"),
    writeFile(path.join(repoPath, directory, "99-after.ts"), `${longFile}\n`),
  ]);
}

async function createWorkspaceWithExactSelectionDiff(content: string): Promise<DirtyWorkspace> {
  const repo = await createChangesRepo("changes-canvas-selection-", {
    files: [{ path: "src/selection.ts", content: "" }],
  });
  await writeFile(path.join(repo.path, "src/selection.ts"), `${content}\n`);
  const client = await connectSeedClient();
  cleanupTasks.push({
    run: async () => {
      await client.close().catch(() => undefined);
      await repo.cleanup().catch(() => undefined);
    },
  });
  const created = await client.createWorkspace({ source: { kind: "directory", path: repo.path } });
  if (!created.workspace) throw new Error(created.error ?? "Failed to create selection workspace");
  return { id: created.workspace.id, repoPath: repo.path };
}

async function createWorkspaceWithTwoSelectionDiffs(): Promise<DirtyWorkspace> {
  const repo = await createChangesRepo("changes-canvas-selection-shift-", {
    files: [
      { path: "src/first.ts", content: "" },
      { path: "src/second.ts", content: "" },
    ],
  });
  await Promise.all([
    writeFile(path.join(repo.path, "src/first.ts"), "FIRST\n"),
    writeFile(path.join(repo.path, "src/second.ts"), "ABCDEFGHIJ\n"),
  ]);
  const client = await connectSeedClient();
  cleanupTasks.push({
    run: async () => {
      await client.close().catch(() => undefined);
      await repo.cleanup().catch(() => undefined);
    },
  });
  const created = await client.createWorkspace({ source: { kind: "directory", path: repo.path } });
  if (!created.workspace) throw new Error(created.error ?? "Failed to create selection workspace");
  return { id: created.workspace.id, repoPath: repo.path };
}

async function createWorkspaceWithManyTinyDiffs(fileCount: number): Promise<DirtyWorkspace> {
  const files = Array.from({ length: fileCount }, (_, index) => ({
    path: `src/file-${String(index).padStart(4, "0")}.ts`,
    content: "export const value = 0;\n",
  }));
  const repo = await createChangesRepo("changes-canvas-many-files-", { files });
  await Promise.all(
    files.map((file, index) =>
      writeFile(path.join(repo.path, file.path), `export const value = ${index + 1};\n`),
    ),
  );
  const client = await connectSeedClient();
  cleanupTasks.push({
    run: async () => {
      await client.close().catch(() => undefined);
      await repo.cleanup().catch(() => undefined);
    },
  });
  const created = await client.createWorkspace({ source: { kind: "directory", path: repo.path } });
  if (!created.workspace) throw new Error(created.error ?? "Failed to create many-file workspace");
  return { id: created.workspace.id, repoPath: repo.path };
}

async function createWorkspaceWithStickyTransitionDiff(): Promise<DirtyWorkspace> {
  const source = Array.from(
    { length: 48 },
    (_, index) => `export const value${index} = ${index};`,
  ).join("\n");
  const files = ["src/first.ts", "src/second.ts"].map((filePath) => ({
    path: filePath,
    content: `${source}\n`,
  }));
  const repo = await createChangesRepo("changes-canvas-sticky-transition-", { files });
  const changedSource = Array.from(
    { length: 48 },
    (_, index) => `export const value${index} = ${index + 100};`,
  ).join("\n");
  await Promise.all(
    files.map((file) => writeFile(path.join(repo.path, file.path), `${changedSource}\n`)),
  );
  const client = await connectSeedClient();
  cleanupTasks.push({
    run: async () => {
      await client.close().catch(() => undefined);
      await repo.cleanup().catch(() => undefined);
    },
  });
  const created = await client.createWorkspace({ source: { kind: "directory", path: repo.path } });
  if (!created.workspace) throw new Error(created.error ?? "Failed to create sticky workspace");
  return { id: created.workspace.id, repoPath: repo.path };
}

async function openWorkspaceChanges(page: Page, workspace: DirtyWorkspace): Promise<void> {
  await navigateToWorkspaceChanges(page, workspace);
  await expectExpandedMountedTabDiff(page);
}

async function navigateToWorkspaceChanges(page: Page, workspace: DirtyWorkspace): Promise<void> {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto(buildHostWorkspaceRoute(getServerId(), workspace.id));
  await waitForWorkspaceTabsVisible(page);
  await page.getByTestId("workspace-explorer-toggle").first().click();
  await openChangesInVisibleExplorer(page);
}

/** The Explorer overlay a phone-sized viewport shows, with its Changes tab selected. */
async function openCompactChanges(page: Page, workspace: DirtyWorkspace): Promise<Locator> {
  await page.setViewportSize({ width: 390, height: 844 });
  // Reload at the compact size: panel selection starts at the center on a cold
  // mount, independently of any desktop sidebar used earlier in the test.
  await page.goto(buildHostWorkspaceRoute(getServerId(), workspace.id));
  await page.reload();
  await page.getByTestId("workspace-explorer-toggle").first().click();
  const changesTab = page.getByTestId("workspace-tab-changes_tree").filter({ visible: true });
  await expect(changesTab).toBeVisible({ timeout: 30_000 });
  await changesTab.click();
  const explorer = page.getByTestId("workspace-explorer-sidebar").filter({ visible: true });
  await expect(explorer.getByTestId("changes-header")).toBeVisible({ timeout: 30_000 });
  return explorer;
}

async function openChangedFilesOverview(page: Page): Promise<void> {
  const jumpToFile = page.getByRole("button", { name: "Jump to file" });
  await expect(jumpToFile).toBeVisible();
  await jumpToFile.click();
  await expect(page.getByTestId("changes-jump-to-file-sheet")).toContainText("Jump to file");
}

async function expectOverviewReopensExpanded(
  page: Page,
  folderName: string,
  childFileName: string,
): Promise<void> {
  const sheet = page.getByTestId("changes-jump-to-file-sheet");
  const tree = changesTree(page);
  const folder = tree
    .getByRole("button")
    .filter({ has: page.getByText(folderName, { exact: true }) });
  const child = tree.getByText(childFileName, { exact: true });
  await expect(folder).toBeVisible();
  await expect(child).toBeVisible();
  await folder.click();
  await expect(child).toHaveCount(0);
  await sheet.getByRole("button", { name: "Close", exact: true }).click();
  await openChangedFilesOverview(page);
  await expect(child).toBeVisible();
}

async function jumpToOverviewFile(page: Page, explorer: Locator, filePath: string): Promise<void> {
  const sheet = page.getByTestId("changes-jump-to-file-sheet");
  await changesTree(page).getByText(path.basename(filePath), { exact: true }).click();
  await expect(sheet).toHaveCount(0);
  await expect(diffHeaderForPath(explorer, filePath)).toBeInViewport();
}

async function selectEmptyUncommittedComparison(page: Page, explorer: Locator): Promise<void> {
  await selectChangesComparison(page, "Uncommitted");
  await expect(explorer.getByText("No changes to display", { exact: true })).toBeVisible();
}

async function openWorkspaceChangesSurface(
  page: Page,
  workspace: DirtyWorkspace,
  timeout?: number,
): Promise<void> {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto(buildHostWorkspaceRoute(getServerId(), workspace.id));
  await waitForWorkspaceTabsVisible(page);
  await openChangesPanel(page, timeout);
}

async function openSelectionWorkspaceChanges(page: Page, workspace: DirtyWorkspace): Promise<void> {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto(buildHostWorkspaceRoute(getServerId(), workspace.id));
  await waitForWorkspaceTabsVisible(page);
  await openChangesPanel(page);
  const diffPanel = page.getByTestId("working-diff-panel").filter({ visible: true });
  await expect(diffPanel.getByTestId("diff-file-0")).toHaveAccessibleName(/selection\.ts/, {
    timeout: 30_000,
  });
  await expectExpandedMountedTabDiff(page);
}

async function openChangesInVisibleExplorer(page: Page): Promise<void> {
  const explorer = page.getByTestId("workspace-explorer-sidebar");
  await expect(explorer).toBeVisible({ timeout: 30_000 });
  const changesTab = explorer.getByRole("button", { name: /Working tree diff/i }).first();
  await changesTab.click();
  const changedFile = explorer
    .locator('[data-testid^="diff-tree-file-"][data-testid$="-toggle"]')
    .filter({ visible: true })
    .first();
  await expect(changedFile).toBeVisible({ timeout: 30_000 });
  await changedFile.click();
  await expect(page.getByTestId("working-diff-panel").filter({ visible: true })).toBeVisible({
    timeout: 30_000,
  });
}

async function selectChangesComparison(
  page: Page,
  comparison: "Committed" | "Uncommitted",
): Promise<void> {
  const tree = page.getByTestId("changes-tree-panel").filter({ visible: true });
  if (await tree.getByTestId("vcs-comparison-settings").isVisible()) {
    await tree.getByTestId("vcs-comparison-settings").click();
    await tree.getByTestId("git-comparison-settings-mode").click();
    await page.getByRole("button", { name: comparison, exact: true }).click();
    await tree.getByTestId("vcs-comparison-settings-save").click();
    await expect(tree.getByText("Settings saved", { exact: true })).toBeVisible();
    await expect(tree.getByTestId("git-comparison-settings-mode")).toContainText(comparison);
    await tree.getByTestId("vcs-comparison-settings").click();
    return;
  }
  // COMPAT(vcsComparisonSettings): legacy-host fixtures retain the old settings UI until 2027-06-06.
  await tree.getByTestId("changes-comparison-trigger").click();
  await page
    .getByTestId(
      comparison === "Committed" ? "comparison-committed-auto" : "comparison-uncommitted",
    )
    .click();
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  const backdrop = page.getByRole("button", { name: "Bottom sheet backdrop", exact: true });
  if (await backdrop.isVisible()) {
    await backdrop.click({ position: { x: 5, y: 5 } });
    await expect(backdrop).toHaveCount(0);
  } else {
    await page.keyboard.press("Escape");
  }
  await expect(tree.getByTestId("changes-comparison-trigger")).toContainText(comparison);
}

async function expectWorkingComparisonFiles(
  page: Page,
  comparison: "committed" | "uncommitted",
): Promise<void> {
  const tree = changesTree(page);
  const panel = page.getByTestId("working-diff-panel").filter({ visible: true });
  const paths = ["00-before.ts", "50-target.ts", "99-after.ts"];
  await expect(tree.locator('[data-testid^="diff-tree-file-"][data-testid$="-name"]')).toHaveText(
    paths,
  );
  for (const fileName of paths) {
    await expect(diffHeaderForPath(panel, `${comparison}/${fileName}`)).toBeAttached();
  }
}

async function selectChangedFileAndExpectFocused(page: Page, filePath: string): Promise<void> {
  const tree = changesTree(page);
  const panel = page.getByTestId("working-diff-panel").filter({ visible: true });
  const scroller = panel.getByTestId("git-diff-scroll");
  await scroller.evaluate((element) => {
    element.scrollTop = 0;
    element.dispatchEvent(new Event("scroll", { bubbles: false }));
  });

  await tree.getByText(path.basename(filePath), { exact: true }).click();
  const header = diffHeaderForPath(panel, filePath);
  await expect(header).toBeVisible();
  await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);

  const [scrollBounds, headerBounds] = await Promise.all([
    scroller.boundingBox(),
    header.boundingBox(),
  ]);
  if (!scrollBounds || !headerBounds)
    throw new Error("Focused diff header geometry is unavailable");
  expect(headerBounds.y - scrollBounds.y).toBeCloseTo(0, 0);
}

async function expectExpandedMountedTabDiff(page: Page): Promise<void> {
  await expect(page.getByTestId("diff-file-0-body")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("git-diff-canvas")).toBeVisible({ timeout: 30_000 });
}

async function changeCodeTypographyFromSettings(
  page: Page,
  typography: { fontSize: number; fontFamily: string },
): Promise<void> {
  await page.getByTestId("sidebar-settings").click();
  await expect(page).toHaveURL(new RegExp(`${buildSettingsSectionRoute("general")}|/settings$`));
  await page.getByRole("button", { name: "Appearance" }).click();
  // A committed font change remounts the screen (AppearanceStyleBoundary), and the new form starts
  // from the stored size. Edit the size only in the remounted form, or the remount drops it.
  const sizeField = page.getByLabel("Code font size");
  await sizeField.evaluate((field) => field.setAttribute("data-e2e-before-font-family", ""));
  await page.getByLabel("Code font family").fill(typography.fontFamily);
  await page.getByLabel("Code font family").press("Enter");
  await expect(page.locator("[data-e2e-before-font-family]")).toHaveCount(0);
  await sizeField.fill(String(typography.fontSize));
  await page.getByLabel("Code font size").press("Enter");
  await expect(page.getByLabel("Code font family")).toHaveValue(typography.fontFamily);
  await expect(page.getByLabel("Code font size")).toHaveValue(String(typography.fontSize));
  await expectStoredCodeFontSize(page, typography.fontSize);
}

async function expectStoredCodeFontSize(page: Page, codeFontSize: number): Promise<void> {
  await expect
    .poll(async () => {
      const raw = await page.evaluate(
        (settingsKey) => localStorage.getItem(settingsKey),
        APP_SETTINGS_KEY,
      );
      if (!raw) {
        return null;
      }
      return (JSON.parse(raw) as { codeFontSize?: number }).codeFontSize ?? null;
    })
    .toBe(codeFontSize);
}

async function saveVcsReview(page: Page, panel: Locator, body: string) {
  await expect(async () => {
    const bounds = await panel.getByTestId("diff-file-0-body").boundingBox();
    const fontSize = await panel
      .getByTestId("git-diff-canvas")
      .evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize));
    if (!bounds) throw new Error("Missing diff body");
    await page.mouse.move(bounds.x + 20, bounds.y + Math.round(fontSize * 1.5) * 1.5);
    await expect(page.getByRole("button", { name: "Add review comment" })).toBeVisible({
      timeout: 500,
    });
  }).toPass({ timeout: 10_000 });
  await page.getByRole("button", { name: "Add review comment" }).click();
  await page.getByRole("textbox", { name: "Review comment", exact: true }).fill(body);
  await page.getByRole("button", { name: "Save review comment", exact: true }).click();
  await expect(panel.getByText(body, { exact: true })).toBeVisible();
  await expect(page.getByTestId("review-comment-sheet")).toBeHidden();
  await expect(page.getByTestId("inline-review-editor")).toBeHidden();
  const toolbar = panel.getByTestId("vcs-diff-toolbar");
  const toolbarBounds = await toolbar.boundingBox();
  if (!toolbarBounds) throw new Error("Missing diff toolbar");
  for (const button of await toolbar.getByRole("button").all()) {
    const buttonBounds = await button.boundingBox();
    if (!buttonBounds) throw new Error("Missing toolbar button");
    expect(buttonBounds.y).toBeGreaterThanOrEqual(toolbarBounds.y);
    expect(buttonBounds.y + buttonBounds.height).toBeLessThanOrEqual(
      toolbarBounds.y + toolbarBounds.height,
    );
  }
  await page.screenshot({
    path: test.info().outputPath(`vcs-review-${page.viewportSize()?.width}.png`),
  });
}

async function startReviewOnFirstChangedLine(
  page: Page,
  side: "unified" | "right" = "unified",
): Promise<void> {
  const body = page.getByTestId("diff-file-0-body");
  const canvas = page.getByTestId("git-diff-canvas");
  const [bodyBounds, fontSize] = await Promise.all([
    body.boundingBox(),
    canvas.evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize)),
  ]);
  if (!bodyBounds) throw new Error("Expanded diff body has no bounds");
  const lineHeight = Math.round(fontSize * 1.5);
  const columnLeft = side === "right" ? bodyBounds.x + bodyBounds.width / 2 : bodyBounds.x;
  await page.mouse.move(columnLeft + 20, bodyBounds.y + lineHeight * 1.5);
  await page.getByRole("button", { name: "Add review comment" }).click();
  await expect(page.getByTestId("inline-review-editor")).toBeVisible();
}

async function clickFirstChangedLine(page: Page): Promise<void> {
  const body = page.getByTestId("diff-file-0-body");
  const canvas = page.getByTestId("git-diff-canvas");
  const [bodyBounds, fontSize] = await Promise.all([
    body.boundingBox(),
    canvas.evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize)),
  ]);
  if (!bodyBounds) throw new Error("Expanded diff body has no bounds");
  const lineHeight = Math.round(fontSize * 1.5);
  await page.mouse.click(bodyBounds.x + 120, bodyBounds.y + lineHeight * 1.5);
}

async function openCopyableSelectionDiff(page: Page, content: string): Promise<void> {
  const workspace = await createWorkspaceWithExactSelectionDiff(content);
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await configureDiffPresentation(page, { layout: "unified", wrapLines: false });
  await openSelectionWorkspaceChanges(page, workspace);
}

async function copyDiffSelectionWithKeyboard(page: Page): Promise<void> {
  await page.evaluate(() => navigator.clipboard.writeText(""));
  await page.keyboard.press("ControlOrMeta+C");
}

async function copyFromChangedLineMenu(page: Page, action: "Copy" | "Copy line"): Promise<void> {
  await page.evaluate(() => navigator.clipboard.writeText(""));
  await rightClickFirstChangedLine(page);
  const item = page.getByRole("menuitem", { name: action, exact: true });
  await expect(item).toBeEnabled();
  await item.click();
}

async function expectClipboardText(page: Page, text: string): Promise<void> {
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(text);
}

async function resizeDiffViewportHeight(page: Page, height: number): Promise<void> {
  const canvas = page.getByTestId("git-diff-canvas");
  const previousViewport = page.viewportSize()!;
  const previousHeight = await canvas.evaluate((element) => element.getBoundingClientRect().height);
  await page.setViewportSize({ width: previousViewport.width, height });
  await expect(canvas).toHaveCSS(
    "height",
    `${previousHeight + height - previousViewport.height}px`,
  );
}

async function rightClickFirstChangedLine(page: Page, fileIndex = 0): Promise<void> {
  const body = page.getByTestId(`diff-file-${fileIndex}-body`);
  const canvas = page.getByTestId("git-diff-canvas");
  const [bodyBounds, fontSize] = await Promise.all([
    body.boundingBox(),
    canvas.evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize)),
  ]);
  if (!bodyBounds) throw new Error("Expanded diff body has no bounds");
  const lineHeight = Math.round(fontSize * 1.5);
  await page.mouse.click(bodyBounds.x + 120, bodyBounds.y + lineHeight * 1.5, {
    button: "right",
  });
}

async function hoverFirstChangedGutter(page: Page): Promise<void> {
  const body = page.getByTestId("diff-file-0-body");
  const canvas = page.getByTestId("git-diff-canvas");
  const [bodyBounds, fontSize] = await Promise.all([
    body.boundingBox(),
    canvas.evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize)),
  ]);
  if (!bodyBounds) throw new Error("Expanded diff body has no bounds");
  const lineHeight = Math.round(fontSize * 1.5);
  const gutterWidth = 2 * Math.ceil(fontSize * 0.62) + 12;
  await page.mouse.move(bodyBounds.x + gutterWidth, bodyBounds.y + lineHeight * 1.5);
}

async function saveInlineReview(page: Page, body: string): Promise<void> {
  await page.getByTestId("inline-review-editor-input").fill(body);
  await page.getByTestId("inline-review-editor-save").click();
  await expect(page.getByText(body, { exact: true })).toBeVisible();
}

async function cancelInlineReview(page: Page): Promise<void> {
  await page.getByTestId("inline-review-editor-cancel").click();
  await expect(page.getByTestId("inline-review-editor")).toHaveCount(0);
}

async function editInlineReview(page: Page, body: string): Promise<void> {
  await page.getByTestId(/^review-comment-edit-/).click();
  await expect(page.getByTestId("inline-review-editor")).toBeVisible();
  await page.getByTestId("inline-review-editor-input").fill(body);
  await page.getByTestId("inline-review-editor-save").click();
  await expect(page.getByText(body, { exact: true })).toBeVisible();
}

async function deleteInlineReview(page: Page): Promise<void> {
  await page.getByTestId(/^review-comment-delete-/).click();
  await expect(page.getByTestId(/^review-comment-delete-/)).toHaveCount(0);
}

async function dragExactAddedText(
  page: Page,
  offsets: { startOffset: number; endOffset: number },
  fileIndex = 0,
): Promise<void> {
  const body = page.getByTestId(`diff-file-${fileIndex}-body`);
  const canvas = page.getByTestId("git-diff-canvas");
  const [bodyBounds, metrics] = await Promise.all([
    body.boundingBox(),
    canvas.evaluate((element) => {
      const style = getComputedStyle(element);
      const fontSize = Number.parseFloat(style.fontSize);
      const measurementCanvas = document.createElement("canvas");
      const context = measurementCanvas.getContext("2d")!;
      context.font = `${fontSize}px ${style.fontFamily}`;
      return { fontSize, characterWidth: context.measureText("A").width };
    }),
  ]);
  if (!bodyBounds) throw new Error("Expanded diff body has no bounds");
  const lineHeight = Math.round(metrics.fontSize * 1.5);
  const gutterWidth = Math.max(2, String(1).length) * Math.ceil(metrics.fontSize * 0.62) + 12;
  const textLeft = bodyBounds.x + gutterWidth + 8;
  await page.mouse.move(
    textLeft + offsets.startOffset * metrics.characterWidth + 1,
    bodyBounds.y + lineHeight * 1.5,
  );
  await page.mouse.down();
  await page.mouse.move(
    textLeft + offsets.endOffset * metrics.characterWidth - 1,
    bodyBounds.y + lineHeight * 1.5,
    { steps: 8 },
  );
  await page.mouse.up();
}

async function dragAddedTextRange(
  page: Page,
  input: {
    lines: string[];
    start: { line: number; offset: number };
    end: { line: number; offset: number };
    side?: "left" | "right";
    wrapped?: boolean;
    horizontalOffset?: number;
  },
): Promise<void> {
  const body = page.getByTestId("diff-file-0-body");
  const canvas = page.getByTestId("git-diff-canvas");
  const [bounds, metrics] = await Promise.all([
    body.boundingBox(),
    canvas.evaluate((element) => {
      const style = getComputedStyle(element);
      const fontSize = Number.parseFloat(style.fontSize);
      const context = document.createElement("canvas").getContext("2d")!;
      context.font = `${fontSize}px ${style.fontFamily}`;
      return { fontSize, characterWidth: context.measureText("A").width };
    }),
  ]);
  if (!bounds) throw new Error("Expanded diff body has no bounds");
  const lineHeight = Math.round(metrics.fontSize * 1.5);
  const gutterWidth = 2 * Math.ceil(metrics.fontSize * 0.62) + 12;
  const columnWidth = input.side ? bounds.width / 2 : bounds.width;
  const columnLeft = input.side === "right" ? bounds.x + columnWidth : bounds.x;
  const availableWidth = columnWidth - gutterWidth - 16;
  const charactersPerFragment = Math.max(1, Math.floor(availableWidth / metrics.characterWidth));
  const fragmentsBefore = (line: number) =>
    input.wrapped
      ? input.lines
          .slice(0, line)
          .reduce(
            (total, text) => total + Math.max(1, Math.ceil(text.length / charactersPerFragment)),
            0,
          )
      : line;
  const point = ({ line, offset }: { line: number; offset: number }) => {
    const fragment = input.wrapped ? Math.floor(offset / charactersPerFragment) : 0;
    const localOffset = input.wrapped ? offset % charactersPerFragment : offset;
    return {
      x:
        columnLeft +
        gutterWidth +
        8 +
        localOffset * metrics.characterWidth -
        (input.horizontalOffset ?? 0),
      y: bounds.y + (1 + fragmentsBefore(line) + fragment + 0.5) * lineHeight,
    };
  };
  const start = point(input.start);
  const end = point(input.end);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 12 });
  await page.mouse.up();
}

async function readSelectionPaintSamples(
  page: Page,
  side: "unified" | "right" = "unified",
): Promise<{ gutter: number[]; code: number[]; opposite: number[] }> {
  return page.getByTestId("diff-file-0-body").evaluate((body, selectedSide) => {
    const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="git-diff-canvas"]')!;
    const bodyBounds = body.getBoundingClientRect();
    const canvasBounds = canvas.getBoundingClientRect();
    const scaleX = canvas.width / canvasBounds.width;
    const scaleY = canvas.height / canvasBounds.height;
    const context = canvas.getContext("2d")!;
    const sample = (left: number, top: number, width: number, height: number) =>
      Array.from(
        context.getImageData(
          Math.round((left - canvasBounds.left) * scaleX),
          Math.round((top - canvasBounds.top) * scaleY),
          Math.max(1, Math.round(width * scaleX)),
          Math.max(1, Math.round(height * scaleY)),
        ).data,
      );
    const columnLeft =
      selectedSide === "right" ? bodyBounds.left + bodyBounds.width / 2 : bodyBounds.left;
    return {
      gutter: sample(columnLeft + 2, bodyBounds.top + 24, 8, 8),
      code: sample(columnLeft + 80, bodyBounds.top + 24, 80, 10),
      opposite: sample(bodyBounds.left + 80, bodyBounds.top + 24, 80, 10),
    };
  }, side);
}

async function dragWithinFirstAddedGrapheme(page: Page): Promise<void> {
  const bodyBounds = await page.getByTestId("diff-file-0-body").boundingBox();
  const fontSize = await page
    .getByTestId("git-diff-canvas")
    .evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize));
  if (!bodyBounds) throw new Error("Expanded diff body has no bounds");
  const lineHeight = Math.round(fontSize * 1.5);
  const gutterWidth = 2 * Math.ceil(fontSize * 0.62) + 12;
  const x = bodyBounds.x + gutterWidth + 10;
  const y = bodyBounds.y + lineHeight * 1.5;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 5, y, { steps: 3 });
  await page.mouse.up();
}

async function dragFirstAddedLineIntoHeader(page: Page): Promise<void> {
  const bodyBounds = await page.getByTestId("diff-file-0-body").boundingBox();
  const fontSize = await page
    .getByTestId("git-diff-canvas")
    .evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize));
  if (!bodyBounds) throw new Error("Expanded diff body has no bounds");
  const lineHeight = Math.round(fontSize * 1.5);
  const x = bodyBounds.x + 60;
  await page.mouse.move(x, bodyBounds.y + lineHeight * 1.5);
  await page.mouse.down();
  await page.mouse.move(x, bodyBounds.y - 10, { steps: 4 });
  await page.mouse.up();
}

async function horizontallyScrollFirstFile(page: Page, requestedOffset: number): Promise<number> {
  const horizontalScroll = page.getByTestId("diff-file-0-horizontal-scroll");
  const retainedOffset = await horizontalScroll.evaluate((element, offset) => {
    element.scrollLeft = offset;
    element.dispatchEvent(new Event("scroll"));
    return element.scrollLeft;
  }, requestedOffset);
  expect(retainedOffset).toBeGreaterThan(0);
  return retainedOffset;
}

async function measureInFlowHeaderMotion(
  page: Page,
): Promise<{ headerSurface: number; shell: number }> {
  return page.getByTestId("git-diff-scroll").evaluate(async (element) => {
    const scroll = element as HTMLElement;
    const headerSurface = document.querySelector<HTMLElement>('[data-testid="git-diff-canvas"]');
    const shell = document.querySelector<HTMLElement>('[data-diff-header-path="src/second.ts"]');
    if (!headerSurface || !shell) throw new Error("Diff header motion surfaces are unavailable");

    const shellDocumentTop =
      scroll.scrollTop + shell.getBoundingClientRect().top - scroll.getBoundingClientRect().top;
    scroll.scrollTop = Math.max(0, shellDocumentTop - scroll.clientHeight + 80);
    scroll.dispatchEvent(new Event("scroll", { bubbles: false }));
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );

    const before = {
      headerSurface: headerSurface.getBoundingClientRect().top,
      shell: shell.getBoundingClientRect().top,
    };
    scroll.scrollTop += 120;
    const after = {
      headerSurface: headerSurface.getBoundingClientRect().top,
      shell: shell.getBoundingClientRect().top,
    };
    return {
      headerSurface: after.headerSurface - before.headerSurface,
      shell: after.shell - before.shell,
    };
  });
}

async function longPressFileHeader(page: Page, header: Locator): Promise<void> {
  const bounds = await header.boundingBox();
  if (!bounds) throw new Error("File header has no bounds");
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(600);
  await page.mouse.up();
}

async function headerCanvasPixel(
  canvas: Locator,
  header: Locator,
  offsetY: number,
): Promise<string> {
  const [canvasBounds, headerBounds] = await Promise.all([
    canvas.boundingBox(),
    header.boundingBox(),
  ]);
  if (!canvasBounds || !headerBounds) throw new Error("Canvas header has no bounds");
  return canvas.evaluate(
    (element, point) => {
      const target = element as HTMLCanvasElement;
      const ratio = target.width / target.getBoundingClientRect().width;
      const context = target.getContext("2d");
      if (!context) throw new Error("Canvas header has no 2D context");
      return Array.from(
        context.getImageData(Math.round(point.x * ratio), Math.round(point.y * ratio), 1, 1).data,
      ).join(",");
    },
    { x: 4, y: headerBounds.y - canvasBounds.y + offsetY },
  );
}

async function readDiffTypographyGeometry(page: Page): Promise<{
  horizontalExtent: number;
  canvasPixels: string;
}> {
  const horizontalExtent = await page
    .getByTestId("diff-file-0-horizontal-scroll")
    .evaluate((element) => element.scrollWidth);
  const canvasPixels = (await page.getByTestId("git-diff-canvas").screenshot()).toString("base64");
  return { horizontalExtent, canvasPixels };
}

async function returnToWorkspaceChanges(page: Page): Promise<void> {
  await page.getByTestId("settings-back-to-workspace").click();
  await waitForWorkspaceTabsVisible(page);
  await openChangesInVisibleExplorer(page);
  await expectExpandedMountedTabDiff(page);
}

async function scrollToLowerUnwrappedDiffRows(page: Page): Promise<void> {
  await page.getByTestId("git-diff-scroll").evaluate((element) => {
    element.scrollTop = element.scrollHeight - element.clientHeight;
    element.dispatchEvent(new Event("scroll", { bubbles: false }));
  });
  await expect(page.getByTestId("git-diff-canvas")).toBeVisible();
}

for (const width of [1400, 390]) {
  test(`jj Changes displays diffs, runs extension forms and reports stale targets at width ${width}`, async ({
    page,
  }) => {
    test.setTimeout(120_000);
    page.setDefaultTimeout(15_000);
    const { connectDaemonClient } = await import("../support/helpers/daemon-client-loader");
    const client = await connectDaemonClient<
      import("@getpaseo/client/internal/daemon-client").DaemonClient
    >({ clientIdPrefix: "jj-vcs-ui" });
    const repo = await createTempGitRepo("jj-ui-", {
      files: [
        { path: "counter.ts", content: "export const count = 1;\n" },
        { path: "spaces.txt", content: "one two\n" },
      ],
    });
    execFileSync("jj", ["git", "init", "--colocate", repo.path], { stdio: "pipe" });
    let root: string | undefined;
    let projectId: string | undefined;
    cleanupTasks.push({
      run: async () => {
        if (projectId) await client.removeProject(projectId);
        await client.close();
        if (root) {
          const { rm } = await import("node:fs/promises");
          await rm(root, { recursive: true, force: true });
        }
        await repo.cleanup();
      },
    });
    const project = await client.addProject(repo.path);
    if (!project.project) throw new Error(project.error ?? "Missing jj project");
    projectId = project.project.projectId;
    const created = await client.createWorkspace({
      source: { kind: "working-copy", projectId: project.project.projectId },
    });
    if (!created.workspace?.workspaceDirectory)
      throw new Error(created.error ?? "Missing jj workspace");
    root = created.workspace.workspaceDirectory;
    execFileSync("jj", ["bookmark", "create", "comparison-base", "-r", "@-"], {
      cwd: root,
      stdio: "pipe",
    });
    await writeFile(path.join(root, "spaces.txt"), "one   two\n");
    await writeFile(path.join(root, "counter.ts"), "export const count = 2;\n");
    await page.setViewportSize({ width, height: 900 });
    await configureDiffPresentation(page, {
      layout: "unified",
      wrapLines: false,
      inlineDiff: true,
    });
    await page.goto(buildHostWorkspaceRoute(getServerId(), created.workspace.id));
    await expect(
      page.getByRole("button", { name: "Open Explorer sidebar", exact: true }),
    ).toBeVisible();
    if (width === 390) {
      await page.reload();
      await page.getByTestId("workspace-explorer-toggle").first().click();
      await page.getByTestId("workspace-tab-changes_tree").filter({ visible: true }).click();
    } else {
      await page.keyboard.press(`${process.platform === "darwin" ? "Meta" : "Control"}+Shift+G`);
    }
    const panel = page.getByTestId("vcs-panel").filter({ visible: true });
    await expect(panel).toBeVisible({ timeout: 30_000 });
    await expect(panel.getByTestId("diff-file-0")).toHaveAccessibleName(/counter\.ts/);

    const settingsToggle = page.getByTestId("vcs-comparison-settings").filter({ visible: true });
    await settingsToggle.click();
    await page.getByTestId("vcs-comparison-settings-scope").click();
    await page.getByRole("button", { name: "Project", exact: true }).click();
    await page.getByTestId("jj-comparison-settings-mode").click();
    await page.getByRole("button", { name: "Since bookmark", exact: true }).click();
    await page.getByTestId("vcs-comparison-settings-save").click();
    await expect(page.getByText("Settings saved", { exact: true })).not.toBeVisible();
    await page.getByTestId("jj-comparison-settings-base").click();
    await page.getByRole("button", { name: "comparison-base", exact: true }).click();
    await page.getByTestId("vcs-comparison-settings-save").click();
    await expect(page.getByText("Settings saved", { exact: true })).toBeVisible();
    const target = { kind: "workspace" as const, workspaceId: created.workspace.id };
    const inherited = await client.requestVcs({
      type: "vcs.comparison.get.request",
      target,
      providerId: "jj",
    });
    expect(inherited.selection).toBeNull();
    expect(inherited.effective).toMatchObject({ version: 1, data: { mode: "base" } });
    await page.getByTestId("vcs-comparison-settings-scope").click();
    await page.getByRole("button", { name: "Workspace", exact: true }).click();
    await expect(page.getByTestId("jj-comparison-settings-base")).toContainText("comparison-base");
    await page.getByTestId("jj-comparison-settings-mode").click();
    await page.getByRole("button", { name: "Current change", exact: true }).click();
    await page.getByTestId("vcs-comparison-settings-save").click();
    await expect(page.getByText("Settings saved", { exact: true })).toBeVisible();
    await settingsToggle.click();
    await settingsToggle.click();
    await expect(page.getByTestId("jj-comparison-settings-mode")).toContainText("Current change");
    await page.getByTestId("vcs-comparison-settings-reset").click();
    await expect(page.getByTestId("jj-comparison-settings-base")).toContainText("comparison-base");
    await settingsToggle.click();
    // Keep the later explicit-comparison assertions independent of saved defaults.
    await client.requestVcs({
      type: "vcs.comparison.set.request",
      target: { kind: "project", projectId },
      providerId: "jj",
      value: null,
    });

    await panel.getByTestId("vcs-comparison").click();
    await page.getByRole("button", { name: "Since bookmark", exact: true }).click();
    await expect(
      panel.getByText("Select a bookmark with one unambiguous target.", { exact: true }),
    ).toBeVisible();
    await panel.getByTestId("vcs-comparison-base").click();
    await page.getByRole("button", { name: "comparison-base", exact: true }).click();
    await expect(panel.getByTestId("diff-file-0")).toHaveAccessibleName(/counter\.ts/);
    await panel.getByTestId("vcs-comparison").click();
    await page.getByRole("button", { name: "Current change", exact: true }).click();
    await panel.getByTestId("vcs-comparison").click();
    await page.getByRole("button", { name: "Between revisions", exact: true }).click();
    await expect(panel.getByTestId("diff-file-1")).toHaveAccessibleName("spaces.txt, +1, -1");
    await panel.getByTestId("vcs-whitespace").click();
    await expect(panel.getByTestId("diff-file-1")).toHaveAccessibleName("spaces.txt, +0, -0");
    await panel.getByTestId("vcs-whitespace").click();
    await expect(panel.getByTestId("diff-file-1")).toHaveAccessibleName("spaces.txt, +1, -1");
    await panel.getByTestId("vcs-comparison").click();
    await page.getByRole("button", { name: "Current change", exact: true }).click();
    await saveVcsReview(page, panel, "Review from jj Changes");
    await panel.getByTestId("diff-file-0").click({ button: "right" });
    await expect(page.getByTestId("vcs-file-action-restore")).toBeVisible();
    await expect(page.getByTestId("diff-file-0-download")).toBeVisible();
    await page.keyboard.press("Escape");
    await writeFile(
      path.join(root, "counter.ts"),
      "export const count = 3;\nexport const extra = true;\n",
    );
    await expect(panel.getByTestId("diff-file-0")).toHaveAccessibleName("counter.ts, +2, -1", {
      timeout: 15000,
    });
    await expect(panel.getByText("Review from jj Changes", { exact: true })).toBeVisible();
    execFileSync("jj", ["describe", "-m", "External watched"], { cwd: root, stdio: "pipe" });
    await panel.getByTestId("vcs-view").click();
    await page.getByRole("button", { name: "History", exact: true }).last().click();
    await expect(panel.getByText("External watched", { exact: true })).toBeVisible({
      timeout: 15000,
    });
    await panel.getByText("External watched", { exact: true }).click();
    await expect(panel.getByTestId("diff-file-1")).toHaveAccessibleName("spaces.txt, +1, -1");
    await panel.getByTestId("vcs-whitespace").click();
    await expect(panel.getByTestId("diff-file-1")).toHaveAccessibleName("spaces.txt, +0, -0");
    await panel.getByTestId("vcs-whitespace").click();
    await expect(panel.getByTestId("diff-file-1")).toHaveAccessibleName("spaces.txt, +1, -1");
    await panel.getByRole("button", { name: "Working copy", exact: true }).click();
    await expect(page.getByRole("button", { name: "References", exact: true })).toBeHidden();
    await panel.getByTestId("vcs-view").click();
    await page.getByRole("button", { name: "Changes", exact: true }).last().click();
    await expect(page.getByRole("button", { name: "References", exact: true })).toBeHidden();
    if (width === 390)
      await page
        .getByRole("button", { name: "Close Explorer sidebar", exact: true })
        .last()
        .click();
    await page.getByTestId("workspace-header-menu-trigger").filter({ visible: true }).click();
    await page.getByTestId("workspace-vcs-action-describe").click();
    await expect(page.getByTestId("jj-message")).toBeVisible();
    await page.getByTestId("jj-message").fill("Description from Paseo");
    let previewMessage = "";
    page.once("dialog", async (dialog) => {
      previewMessage = dialog.message();
      await dialog.dismiss();
    });
    await page.getByTestId("vcs-action-submit").click();
    await expect(page.getByTestId("vcs-action-submit")).toBeEnabled();
    expect(previewMessage).toContain("External watched");
    expect(previewMessage).toContain(
      execFileSync(
        "jj",
        ["log", "--ignore-working-copy", "--no-graph", "-r", "@", "-T", "commit_id"],
        { cwd: root, encoding: "utf8" },
      ),
    );
    await expect(panel.getByTestId("vcs-operation")).toHaveCount(0);
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByTestId("vcs-action-submit").click();
    await expect(panel.getByTestId("vcs-operation")).toContainText("Operation completed");
    expect(
      execFileSync(
        "jj",
        ["log", "--ignore-working-copy", "--no-graph", "-r", "@", "-T", "description"],
        { cwd: root, encoding: "utf8" },
      ),
    ).toBe("Description from Paseo\n");
    await panel
      .getByTestId("vcs-operation")
      .getByRole("button", { name: "Dismiss", exact: true })
      .click();
    await expect(panel.getByTestId("vcs-operation")).toHaveCount(0);
    await page.reload();
    await expect(panel).toBeVisible({ timeout: 30_000 });
    await expect(panel.getByTestId("vcs-operation")).toHaveCount(0);
    await expect(page.getByTestId("vcs-action-sheet")).toBeHidden();
    if (width === 390) await page.getByRole("button", { name: "Open menu", exact: true }).click();
    const commands = await openCommandCenter(page);
    await commands.getByTestId("command-center-input").fill("describe");
    await commands.getByText("Describe change", { exact: true }).click();
    await expect(page.getByTestId("jj-message")).toHaveValue("Description from Paseo\n");
    execFileSync("jj", ["describe", "-m", "External edit"], { cwd: root, stdio: "pipe" });
    await page.getByTestId("jj-message").fill("Must not overwrite external work");
    await page.getByTestId("vcs-action-submit").click();
    await expect(page.getByRole("alert").filter({ hasText: "Repository changed" })).toBeVisible();
    expect(
      execFileSync(
        "jj",
        ["log", "--ignore-working-copy", "--no-graph", "-r", "@", "-T", "description"],
        { cwd: root, encoding: "utf8" },
      ),
    ).toBe("External edit\n");
    await page
      .getByTestId("vcs-action-sheet")
      .getByRole("button", { name: "Close", exact: true })
      .click();
    await panel.getByTestId("vcs-view").click();
    await page.getByRole("button", { name: "History", exact: true }).last().click();
    await expect(panel.getByText("External edit", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "References", exact: true })).toBeHidden();
    await page.screenshot({ path: test.info().outputPath(`jj-history-${width}.png`) });
  });
}

const externalVcsTest = test.extend({
  e2eDaemonEnvironment: [
    async ({ e2eDaemonConfig }, provide) => {
      void e2eDaemonConfig;
      const { mkdtemp, rm } = await import("node:fs/promises");
      const { tmpdir } = await import("node:os");
      const directory = await mkdtemp(path.join(tmpdir(), "vcs-ui-forge-"));
      const script = `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const counter = path.join(__dirname, "creates");
if (args.includes("POST") && args.some(value => value.endsWith("/pulls"))) {
  const count = fs.existsSync(counter) ? Number(fs.readFileSync(counter, "utf8")) + 1 : 1;
  fs.writeFileSync(counter, String(count));
  if (count === 1) { process.stderr.write("Forge temporarily unavailable"); process.exit(1); }
  process.stdout.write(JSON.stringify({ url: "https://api.github.com/repos/paseo/vcs-ui/pulls/7", html_url: "https://github.com/paseo/vcs-ui/pull/7", number: 7 }));
} else if (args[0] === "pr" && args[1] === "view") { process.stderr.write("no pull requests found"); process.exit(1); }
else if (args[0] === "repo" && args[1] === "view") { process.stdout.write(JSON.stringify({ name: "vcs-ui", owner: { login: "paseo" } })); }
else if (args[0] === "pr" && args[1] === "list" && args[args.indexOf("--head") + 1] === "existing") {
  process.stdout.write(JSON.stringify([{ number: 8, url: "https://github.com/paseo/vcs-ui/pull/8", title: "Existing external request", state: "OPEN", baseRefName: "main", headRefName: "existing", headRefOid: "revision:Changed from custom panel", headRepositoryOwner: { login: "paseo" }, statusCheckRollup: [{ __typename: "CheckRun", name: "Example check", status: "COMPLETED", conclusion: "SUCCESS", detailsUrl: "https://github.com/paseo/vcs-ui/actions/runs/8" }] }]));
} else if (args[0] === "api" && args[1] === "graphql") { process.stderr.write("Optional facts unavailable"); process.exit(1); }
else { process.stdout.write("[]"); }
`;
      await writeFile(path.join(directory, "gh"), script, { mode: 0o755 });
      try {
        await provide({ PATH: directory + path.delimiter + process.env.PATH });
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
    { scope: "worker" },
  ],
});

for (const { width, loseReply } of [
  { width: 1400, loseReply: false },
  { width: 390, loseReply: false },
  { width: 1400, loseReply: true },
]) {
  test(`jj working-copy creation uses the selected revision at width ${width}${loseReply ? " after losing the reply" : ""}`, async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const { connectDaemonClient } = await import("../support/helpers/daemon-client-loader");
    const client = await connectDaemonClient<
      import("@getpaseo/client/internal/daemon-client").DaemonClient
    >({ clientIdPrefix: "jj-copy-ui" });
    const repo = await createTempGitRepo("jj-copy-ui-", {
      files: [{ path: "sub/file.txt", content: "Original\n" }],
    });
    execFileSync("jj", ["git", "init", "--colocate", repo.path], { stdio: "pipe" });
    const revision = execFileSync(
      "jj",
      ["log", "--ignore-working-copy", "--no-graph", "-r", "@-", "-T", "commit_id"],
      { cwd: repo.path, encoding: "utf8" },
    ).trim();
    let projectId: string | undefined;
    cleanupTasks.push({
      run: async () => {
        if (projectId) await client.removeProject(projectId);
        await client.close();
        await repo.cleanup();
      },
    });
    const source = await client.createWorkspace({
      source: { kind: "directory", path: path.join(repo.path, "sub") },
    });
    if (!source.workspace) throw new Error(source.error ?? "Missing source workspace");
    projectId = source.workspace.projectId;
    const creationKeys: string[] = [];
    let deliverCreation = !loseReply;
    if (loseReply) {
      const frames = await loadSessionMessageReaders();
      await page.routeWebSocket(daemonWsRoutePattern(), (browser) => {
        const server = browser.connectToServer();
        browser.onMessage((frame) => {
          const message = frames.client(frame);
          if (message?.type === "workspace.create.request" && message.idempotencyKey)
            creationKeys.push(message.idempotencyKey);
          server.send(frame);
        });
        server.onMessage((frame) => {
          const message = frames.server(frame);
          if (
            !deliverCreation &&
            message &&
            [
              "workspace.create.response",
              "workspace.create.update",
              "creation.subscribe.response",
            ].includes(message.type)
          )
            return;
          browser.send(frame);
        });
      });
    }
    await page.setViewportSize({ width, height: 900 });
    await page.goto(buildHostWorkspaceRoute(getServerId(), source.workspace.id));
    await page.getByTestId("workspace-header-menu-trigger").filter({ visible: true }).click();
    await page.getByTestId("workspace-vcs-view-working-copy").click();
    const panel = page.getByTestId("vcs-panel").filter({ visible: true });
    await panel.getByTestId("vcs-copy-title").fill("Isolated from jj");
    await panel.getByTestId("jj-working-copy-name").fill("from-changes");
    await panel.getByTestId("vcs-copy-revision").click();
    await page.getByRole("button", { name: new RegExp(revision) }).click();
    await writeFile(path.join(repo.path, "sub/file.txt"), "Newer source contents\n");
    await panel.getByTestId("vcs-copy-create").click();
    if (loseReply) {
      await expect
        .poll(
          async () =>
            (await client.fetchWorkspaces()).entries.filter(
              (workspace) => workspace.projectId === projectId,
            ).length,
        )
        .toBe(2);
      await expect(panel.getByText("Creating working copy…", { exact: true })).toBeVisible();
      deliverCreation = true;
      await page.reload();
      await expect(panel.getByTestId("vcs-copy-create")).toHaveText("Check creation result");
      expect(creationKeys).toHaveLength(1);
      await panel.getByTestId("vcs-copy-create").click();
    }
    await expect(panel.getByTestId("vcs-copy-success")).toBeVisible({ timeout: 30_000 });
    if (loseReply) {
      expect(creationKeys).toHaveLength(2);
      expect(new Set(creationKeys).size).toBe(1);
    }
    const copies = (await client.fetchWorkspaces()).entries.filter(
      (workspace) => workspace.projectId === projectId && workspace.id !== source.workspace!.id,
    );
    expect(copies).toHaveLength(1);
    const copy = copies[0]!;
    expect(copy.name).toBe("Isolated from jj");
    expect(
      execFileSync("jj", ["workspace", "root", "--name", "from-changes"], {
        cwd: repo.path,
        encoding: "utf8",
      }).trim(),
    ).toBe(path.dirname(copy.workspaceDirectory!));
    expect(copy.workspaceDirectory).not.toBe(source.workspace.workspaceDirectory);
    expect(path.basename(copy.workspaceDirectory!)).toBe("sub");
    expect(await readFile(path.join(copy.workspaceDirectory!, "file.txt"), "utf8")).toBe(
      "Original\n",
    );
    await page.reload();
    await expect(panel.getByTestId("vcs-copy-success")).toBeVisible();
    await expect(panel.getByTestId("jj-working-copy-name")).toHaveValue("from-changes");
    await expect(panel.getByTestId("jj-working-copy-name")).not.toBeEditable();
    expect(
      (await client.fetchWorkspaces()).entries.filter(
        (workspace) => workspace.projectId === projectId,
      ),
    ).toHaveLength(2);
    await panel.getByTestId("vcs-copy-open").click();
    await expect(page).toHaveURL(new RegExp(`/workspace/${copy.id}`));
  });
}

for (const width of [1400, 390]) {
  test(`checkpoint-vcs example uses the public VCS surfaces at width ${width}`, async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const { connectDaemonClient } = await import("../support/helpers/daemon-client-loader");
    const { createTempDirectory } = await import("../support/helpers/workspace");
    const client = await connectDaemonClient<
      import("@getpaseo/client/internal/daemon-client").DaemonClient
    >({ clientIdPrefix: "checkpoint-example" });
    const example = await copyPluginExample("checkpoint-vcs");
    const fixture = await createTempDirectory("checkpoint-ui-");
    const repo = path.join(fixture.path, "repository");
    execFileSync(process.execPath, [path.join(example.directory, "init.mjs"), repo]);
    const previous = await client.getDaemonConfig();
    let projectId: string | undefined;
    let copyId: string | undefined;
    let aliasId: string | undefined;
    let aliasProjectId: string | undefined;
    cleanupTasks.push({
      run: async () => {
        if (aliasId) await client.archiveWorkspace(aliasId);
        if (copyId) await client.archiveWorkspace(copyId);
        if (aliasProjectId && aliasProjectId !== projectId)
          await client.removeProject(aliasProjectId);
        if (projectId) await client.removeProject(projectId);
        await client.removePlugin("checkpoint-vcs").catch(() => undefined);
        await client.patchDaemonConfig({ pluginsEnabled: previous.config.pluginsEnabled });
        await client.close();
        await example.cleanup();
        await fixture.cleanup();
      },
    });
    await client.patchDaemonConfig({ pluginsEnabled: true });
    await client.installDirectoryPlugin(example.directory);
    const created = await client.createWorkspace({ source: { kind: "directory", path: repo } });
    if (!created.workspace) throw new Error(created.error ?? "Missing checkpoint workspace");
    projectId = created.workspace.projectId;
    await page.setViewportSize({ width, height: 900 });
    await configureDiffPresentation(page, {
      layout: "unified",
      wrapLines: false,
      inlineDiff: true,
    });
    await page.goto(buildHostWorkspaceRoute(getServerId(), created.workspace.id));
    await page.getByTestId("workspace-header-menu-trigger").filter({ visible: true }).click();
    await page.getByTestId("workspace-vcs-view-plugin:details").click();
    const panel = page.getByTestId("vcs-panel").filter({ visible: true });
    await expect(panel.getByTestId("checkpoint-current")).toHaveText("No checkpoints yet");
    await panel.getByTestId("vcs-view").click();
    await page.getByRole("button", { name: "Changes", exact: true }).last().click();
    await expect(panel.getByTestId("diff-file-0")).toHaveAccessibleName("note.txt, +1, -0");
    if (width === 390) await page.getByRole("button", { name: "Open menu", exact: true }).click();
    const commands = await openCommandCenter(page);
    await commands.getByTestId("command-center-input").fill("Create checkpoint");
    await commands.getByText("Create checkpoint", { exact: true }).click();
    await expect(page.getByTestId("checkpoint-save")).toBeDisabled();
    await page.getByTestId("checkpoint-description").fill("Initial checkpoint");
    await page.getByTestId("checkpoint-save").click();
    await expect(panel.getByTestId("vcs-operation")).toContainText("Operation completed");
    await panel.getByTestId("vcs-view").click();
    await page.getByRole("button", { name: "History", exact: true }).last().click();
    await expect(panel.getByText("Initial checkpoint", { exact: true })).toBeVisible();
    await panel.getByTestId(/^vcs-revision-/).click();
    await expect(panel.getByTestId("diff-file-0")).toHaveAccessibleName("note.txt, +1, -0");
    await writeFile(path.join(repo, "note.txt"), "Changed outside Paseo\n");
    if (width === 390) await page.getByRole("button", { name: "Open menu", exact: true }).click();
    const nextCommands = await openCommandCenter(page);
    await nextCommands.getByTestId("command-center-input").fill("Checkpoint details");
    await nextCommands.getByText("Checkpoint details", { exact: true }).click();
    await expect(panel.getByTestId("checkpoint-current")).toHaveText("Initial checkpoint");
    await expect(panel.getByText("Changed files: 1", { exact: true })).toBeVisible();
    await page.getByTestId("workspace-header-menu-trigger").filter({ visible: true }).click();
    await page.getByTestId("workspace-vcs-action-checkpoint.create").click();
    await page.getByTestId("checkpoint-description").fill("Must not save a stale checkpoint");
    await writeFile(path.join(repo, "note.txt"), "Edited while the form was open\n");
    await page.getByTestId("checkpoint-save").click();
    await expect(panel.getByTestId("vcs-operation")).toContainText("Repository changed");
    await expect(panel.getByTestId("checkpoint-current")).toHaveText("Initial checkpoint");
    await client.disablePlugin("checkpoint-vcs");
    await expect(panel.getByTestId("checkpoint-current")).toHaveCount(0);
    await client.enablePlugin("checkpoint-vcs");
    await expect(panel.getByTestId("checkpoint-current")).toHaveText("Initial checkpoint");

    await page.getByTestId("workspace-header-menu-trigger").filter({ visible: true }).click();
    await page.getByTestId("workspace-vcs-view-working-copy").click();
    await panel.getByTestId("vcs-copy-title").fill("Checkpoint lifecycle");
    await panel.getByTestId("vcs-copy-create").click();
    await expect(panel.getByTestId("vcs-copy-success")).toBeVisible({ timeout: 30_000 });
    const copies = (await client.fetchWorkspaces()).entries.filter(
      (entry) => entry.projectId === projectId && entry.id !== created.workspace!.id,
    );
    expect(copies).toHaveLength(1);
    const copy = copies[0]!;
    copyId = copy.id;
    if (!copy.workspaceDirectory) throw new Error("Missing isolated copy path");
    const note = path.join(copy.workspaceDirectory, "note.txt");
    const original = await readFile(note, "utf8");
    expect(original).not.toContain("Edited while the form was open");
    await panel.getByTestId("vcs-copy-open").click();
    await expect(page).toHaveURL(new RegExp(`/workspace/${copy.id}`));
    await writeFile(note, "Uncommitted recovery contents\n");
    const subdirectory = path.join(copy.workspaceDirectory, "sub");
    await mkdir(subdirectory);
    const alias = await client.createWorkspace({
      source: { kind: "directory", path: subdirectory },
    });
    if (!alias.workspace) throw new Error(alias.error ?? "Missing shared workspace");
    aliasId = alias.workspace.id;
    aliasProjectId = alias.workspace.projectId;
    expect((await client.archiveWorkspace(copy.id)).error).toBeNull();
    expect(await readFile(note, "utf8")).toBe("Uncommitted recovery contents\n");
    expect((await client.archiveWorkspace(aliasId)).error).toBeNull();
    await expect.poll(() => readFileIfPresent(note)).toBeNull();
    await client.disablePlugin("checkpoint-vcs");
    await client.enablePlugin("checkpoint-vcs");
    await page.goto(buildHostWorkspaceRoute(getServerId(), copy.id));
    const restore = page.getByTestId("workspace-recovery-action");
    await expect(restore).toHaveText("Restore");
    // A conflicting directory must produce a visible error and remain untouched.
    await mkdir(copy.workspaceDirectory);
    const foreign = path.join(copy.workspaceDirectory, "foreign.txt");
    await writeFile(foreign, "Keep this file");
    await restore.click();
    await expect(page.getByTestId("workspace-recovery-error")).toBeVisible();
    expect(await readFile(foreign, "utf8")).toBe("Keep this file");
    await unlink(foreign);
    await rmdir(copy.workspaceDirectory);
    await restore.click();
    await expect.poll(() => readFileIfPresent(note)).toBe("Uncommitted recovery contents\n");
    await expect(page.getByTestId("workspace-recovery-action")).toHaveCount(0);
    await page.getByTestId("workspace-header-menu-trigger").filter({ visible: true }).click();
    await page.getByTestId("workspace-vcs-view-plugin:details").click();
    await expect(panel.getByTestId("checkpoint-current")).toHaveText("Initial checkpoint");
    await expect(panel.getByText("Changed files: 1", { exact: true })).toBeVisible();
    await panel.getByTestId("vcs-view").click();
    await page.getByRole("button", { name: "Changes", exact: true }).last().click();
    await expect(panel.getByTestId("diff-file-0")).toHaveAccessibleName("note.txt, +1, -1");
    expect(await readFile(path.join(repo, "note.txt"), "utf8")).toBe(
      "Edited while the form was open\n",
    );
    await writeFile(note, "New edits after recovery\n");
    await page.goto(buildHostWorkspaceRoute(getServerId(), aliasId));
    await expect(page.getByTestId("workspace-recovery-action")).toHaveText("Unarchive");
    await page.getByTestId("workspace-recovery-action").click();
    await expect(page.getByTestId("workspace-recovery-action")).toHaveCount(0);
    await expect
      .poll(async () =>
        (await client.fetchWorkspaces()).entries.some((entry) => entry.id === aliasId),
      )
      .toBe(true);
    expect(await readFile(note, "utf8")).toBe("New edits after recovery\n");
    await page.getByTestId("workspace-header-menu-trigger").filter({ visible: true }).click();
    await page.getByTestId("workspace-vcs-view-plugin:details").click();
    await expect(panel.getByTestId("checkpoint-current")).toHaveText("Initial checkpoint");
    await expect(panel.getByText("Changed files: 1", { exact: true })).toBeVisible();
  });
}

for (const { history, diff } of [
  { history: false, diff: true },
  { history: false, diff: false },
  { history: true, diff: false },
]) {
  test(`VCS optional reads support Changes, actions and working-copy creation history=${history} diff=${diff}`, async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const { connectDaemonClient } = await import("../support/helpers/daemon-client-loader");
    const { createTempDirectory } = await import("../support/helpers/workspace");
    const client = await connectDaemonClient<
      import("@getpaseo/client/internal/daemon-client").DaemonClient
    >({ clientIdPrefix: "no-history" });
    const example = await copyPluginExample("checkpoint-vcs");
    await writeFile(
      path.join(example.directory, "index.server.ts"),
      `
import { createCheckpointProvider } from "./server/provider.js";
export default function contribute(server) {
  const { ${history ? "" : "history,"} ${diff ? "" : "diff,"} ...provider } = createCheckpointProvider();
  server.registerVcsProvider({ ...provider, async snapshot(binding, context) {
    const snapshot = await provider.snapshot(binding, context);
    return { ...snapshot, files: ${!diff && !history ? 'snapshot.files.length ? [...snapshot.files, { path: "folder/a.txt", previousPath: "old-a.txt", status: "renamed", conflict: false }, { path: "folder/deep/b.txt", status: "modified", conflict: false }, { path: "folder-other/c.txt", status: "modified", conflict: false }] : []' : "snapshot.files"}, capabilities: snapshot.capabilities.filter((capability) => ${history ? "true" : 'capability !== "history"'} ${diff ? "" : '&& capability !== "diff"'}) };
  }});
  return () => {};
}`,
    );
    const clientEntry = path.join(example.directory, "index.client.tsx");
    await writeFile(
      clientEntry,
      (await readFile(clientEntry, "utf8")).replace(
        'contexts: ["workspace"],',
        'contexts: ["workspace"], fileContexts: ["file", "directory"],',
      ),
    );
    const formFile = path.join(example.directory, "client/panels.tsx");
    await writeFile(
      formFile,
      (await readFile(formFile, "utf8"))
        .replace(
          "CheckpointForm({ pending, submit, layout }",
          "CheckpointForm({ pending, submit, layout, context }",
        )
        .replace(
          "<Form>",
          '<Form><Text testID="checkpoint-selected-files">{JSON.stringify(context.selectedFiles ?? [])}</Text>',
        ),
    );
    const fixture = await createTempDirectory("no-history-ui-");
    const repo = path.join(fixture.path, "repository");
    execFileSync(process.execPath, [path.join(example.directory, "init.mjs"), repo]);
    const previous = await client.getDaemonConfig();
    let projectId: string | undefined;
    let copyId: string | undefined;
    cleanupTasks.push({
      run: async () => {
        if (copyId) await client.archiveWorkspace(copyId);
        if (projectId) await client.removeProject(projectId);
        await client.removePlugin("checkpoint-vcs").catch(() => undefined);
        await client.patchDaemonConfig({ pluginsEnabled: previous.config.pluginsEnabled });
        await client.close();
        await example.cleanup();
        await fixture.cleanup();
      },
    });
    await client.patchDaemonConfig({ pluginsEnabled: true });
    await client.installDirectoryPlugin(example.directory);
    const created = await client.createWorkspace({ source: { kind: "directory", path: repo } });
    if (!created.workspace) throw new Error(created.error ?? "Missing workspace");
    projectId = created.workspace.projectId;
    await page.setViewportSize({ width: 390, height: 900 });
    await page.goto(buildHostWorkspaceRoute(getServerId(), created.workspace.id));
    await page.getByTestId("workspace-header-menu-trigger").filter({ visible: true }).click();
    await page.getByTestId("workspace-vcs-view-plugin:details").click();
    const panel = page.getByTestId("vcs-panel").filter({ visible: true });
    await panel.getByTestId("vcs-view").click();
    await expect(page.getByRole("button", { name: "History", exact: true })).toHaveCount(
      history ? 1 : 0,
    );
    await page.getByRole("button", { name: "Changes", exact: true }).last().click();
    if (diff) {
      await expect(panel.getByTestId("diff-file-0")).toHaveAccessibleName("note.txt, +1, -0");
    } else {
      await expect(panel.getByTestId("vcs-status-file-note.txt")).toBeVisible();
      await expect(panel.getByTestId("vcs-status-file-note.txt")).toContainText("added");
      await expect(
        panel.getByText("This provider does not support diffs.", { exact: true }),
      ).toBeVisible();
      await expect(panel.getByTestId("vcs-diff-toolbar")).toHaveCount(0);
      await panel.getByTestId("vcs-status-file-note.txt").click();
      await expect(page.getByRole("dialog", { name: "note.txt", exact: true })).toBeVisible();
      await page
        .getByRole("button", { name: "Close", exact: true })
        .filter({ visible: true })
        .last()
        .click();
    }
    if (diff) {
      await page.getByTestId("workspace-header-menu-trigger").filter({ visible: true }).click();
      await page.getByTestId("workspace-vcs-action-checkpoint.create").click();
    } else {
      if (!history) {
        await expect(panel.getByTestId("vcs-status-file-folder/deep/b.txt")).toBeVisible();
        await panel.getByTestId("vcs-status-folder-folder").click();
        await expect(panel.getByTestId("vcs-status-file-folder/deep/b.txt")).toHaveCount(0);
        await page.reload();
        await expect(panel.getByTestId("vcs-status-folder-folder")).toHaveAttribute(
          "aria-expanded",
          "false",
        );
        await expect(panel.getByTestId("vcs-status-file-folder/deep/b.txt")).toHaveCount(0);
        await panel.getByTestId("vcs-status-folder-folder").click({ button: "right" });
      } else {
        await panel.getByTestId("vcs-status-file-note.txt").click({ button: "right" });
      }
      await page.getByTestId("vcs-file-action-checkpoint.create").click();
      await expect(page.getByTestId("checkpoint-selected-files")).toHaveText(
        history ? '["note.txt"]' : '["folder/a.txt","old-a.txt","folder/deep/b.txt"]',
      );
    }
    await page.getByTestId("checkpoint-description").fill("Without history");
    await page.getByTestId("checkpoint-save").click();
    await expect(panel.getByTestId("vcs-operation")).toContainText("Operation completed");
    if (history) {
      await writeFile(path.join(repo, "note.txt"), "New working contents\n");
      await panel.getByTestId("vcs-view").click();
      await page.getByRole("button", { name: "History", exact: true }).last().click();
      await panel.getByTestId(/^vcs-revision-/).click();
      await expect(
        panel.getByText("This provider does not support diffs.", { exact: true }),
      ).toBeVisible();
      await expect(panel.getByTestId("vcs-status-file-note.txt")).toHaveCount(0);
    }
    await page.getByTestId("workspace-header-menu-trigger").filter({ visible: true }).click();
    await page.getByTestId("workspace-vcs-view-working-copy").click();
    await panel.getByTestId("vcs-copy-title").fill("Copy without history");
    await panel.getByTestId("vcs-copy-create").click();
    await expect(panel.getByTestId("vcs-copy-success")).toBeVisible({ timeout: 30_000 });
    const copies = (await client.fetchWorkspaces()).entries.filter(
      (entry) => entry.projectId === projectId && entry.id !== created.workspace!.id,
    );
    expect(copies).toHaveLength(1);
    copyId = copies[0]!.id;
  });
}

externalVcsTest(
  "external VCS plugin uses shared Changes, history and its own action and panel",
  async ({ page }) => {
    test.setTimeout(120_000);
    page.setDefaultTimeout(15_000);
    const { connectDaemonClient } = await import("../support/helpers/daemon-client-loader");
    const { createTempDirectory } = await import("../support/helpers/workspace");
    const client = await connectDaemonClient<
      import("@getpaseo/client/internal/daemon-client").DaemonClient
    >({ clientIdPrefix: "external-vcs-ui" });
    const fixture = await createTempDirectory("vcs-ui-plugin-");
    const directory = path.join(fixture.path, "plugin");
    const repo = path.join(fixture.path, "repository");
    await mkdir(directory);
    await mkdir(repo);
    await writeFile(path.join(repo, ".external-vcs"), "External initial");
    await writeFile(path.join(repo, "note.txt"), "External diff\n");
    await writeFile(
      path.join(directory, "paseo-plugin.json"),
      JSON.stringify({ id: "vcs-ui-example", requirements: { paseo: ">=0.15.2" } }),
    );
    await writeFile(
      path.join(directory, "index.server.ts"),
      `
import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";
export default function contribute(server) {
  const current = async (binding) => {
    const description = await readFile(path.join(binding.root, ".external-vcs"), "utf8");
    return { id: "revision:" + description, changeId: "stable-change", description, parents: ["base-revision"], author: { name: "External", email: "external@example.test" }, timestamp: "2026-11-06T00:00:00Z", conflict: false };
  };
  server.registerVcsProvider({ id: "external-vcs", label: "External VCS", detectionPriority: 100,
    async detect(cwd) { try { await readFile(path.join(cwd, ".external-vcs")); } catch { return { status: "absent" }; } return { status: "available", binding: { providerId: "external-vcs", repositoryId: await readFile(path.join(cwd, ".external-repository"), "utf8").catch(() => cwd), workingCopyId: cwd, cwd, root: cwd } }; },
    async snapshot(binding) { const revision = await current(binding); return { binding, version: revision.id, current: revision, files: [{ path: "note.txt", status: "modified", conflict: false }], refs: ["task", "existing"].map(name => ({ id: name, name, kind: "custom-reference", targets: [revision.id], publishable: true })), capabilities: ["diff", "history", "refs", "actions", "publication"], actions: [{ id: "change.describe", enabled: revision.description !== "Externally blocked", reason: revision.description === "Externally blocked" ? "External operation in progress" : undefined }], state: "ready" }; },
    workingCopies: {
      async create(binding, input) {
        if (input.data?.version !== 1 || typeof input.data.data?.label !== "string") throw new Error("Missing external copy label");
        await mkdir(input.root);
        await writeFile(path.join(input.root, ".external-vcs"), input.data.data.label);
        await writeFile(path.join(input.root, ".external-repository"), binding.repositoryId);
        await writeFile(path.join(input.root, "note.txt"), input.data.data.label);
        return { owned: true, binding: { ...binding, root: input.root, cwd: input.root, workingCopyId: input.root } };
      },
      async rollback(binding, record) { await rm(record.binding.root, { recursive: true }); },
    },
    publication: {
      async remotes() { return [{ name: "origin", fetchUrl: "https://github.com/paseo/vcs-ui", pushUrls: ["https://github.com/paseo/vcs-ui"] }]; },
      async resolve(binding, selection, snapshot) { return { ...selection, repositoryUrl: "https://github.com/paseo/vcs-ui", headRevision: snapshot.current.id }; },
      async publish(binding, target) { const log = path.join(binding.root, ".external-pushes"); let count = 0; try { count = Number(await readFile(log, "utf8")); } catch {} await writeFile(log, String(count + 1)); await writeFile(path.join(binding.root, ".external-published"), target.headRevision); return target; },
      async verify(binding, target) { if (await readFile(path.join(binding.root, ".external-published"), "utf8") !== target.headRevision) throw new Error("Publication changed"); },
    },
    async observation(binding) { return { fingerprint: (await current(binding)).id, roots: [{ path: binding.root, scope: "working-copy", kind: "files" }] }; },
    async history(binding) { return { revisions: [await current(binding)] }; },
    async diff(binding, comparison) { if (comparison.data?.version === 23) { const options = comparison.data.data; if (options.comparison.kind !== "range" || options.comparison.from !== "base-revision" || !options.comparison.to.startsWith("revision:")) throw new Error("Expected exact external revisions"); if (options.ignoreWhitespace) return ""; } return "diff --git a/note.txt b/note.txt\\n--- a/note.txt\\n+++ b/note.txt\\n@@ -1 +1 @@\\n-Original\\n+External diff\\n"; },
    async execute(binding, action, input) { if (action !== "change.describe" || typeof input?.message !== "string") throw new Error("Missing description"); await writeFile(path.join(binding.root, ".external-vcs"), input.message); return {}; },
  });
  return () => {};
}`,
    );
    await writeFile(
      path.join(directory, "index.client.tsx"),
      `
import { useState } from "react";
import { Text } from "react-native";
import { Form, Field, FormTextInput, Button } from "@getpaseo/plugin/client/ui";
function Describe({ context, pending, submit }) { const [message, setMessage] = useState(context.snapshot.current.description); return <Form><Text testID="external-selected-files">{context.selectedFiles?.join(",") ?? "workspace"}</Text><Field label="External description"><FormTextInput initialValue={message} onChangeText={setMessage} testID="external-vcs-message" /></Field><Button disabled={pending} onPress={() => submit({ message })} testID="external-vcs-submit">Save external description</Button></Form>; }
function Details({ context, runAction }) { return <Form><Text>External panel: {context.snapshot.current.description}</Text><Button onPress={() => runAction("change.describe", { message: "Changed from custom panel" })} testID="external-vcs-custom-action">Run custom panel action</Button></Form>; }
function CopyFields({ value, disabled, onChange }) { return <Field label="External copy label"><FormTextInput initialValue={value?.data?.label ?? ""} editable={!disabled} onChangeText={label => onChange({ version: 1, data: { label } })} testID="external-copy-label" /></Field>; }
function ProjectSource({ context, disabled, onChange }) { return <Button testID="external-project-source" disabled={disabled} onPress={() => onChange({ kind: "working-copy", projectId: context.projectId, cwd: context.snapshot.binding.cwd, providerId: context.snapshot.binding.providerId, revision: context.snapshot.current.id, providerData: { version: 1, data: { label: "Created by external project source" } } })}>Select external source</Button>; }
export default function contribute(client) { return client.addVcsContribution({ resolveRevisionComparison(input) { return { comparison: { kind: "working-copy", data: { version: 23, data: { comparison: input.comparison, ignoreWhitespace: input.ignoreWhitespace } } }, reviewScope: JSON.stringify([input.comparison, input.ignoreWhitespace]) }; }, ProjectSource, workingCopy: { Form: CopyFields }, providerId: "external-vcs", title: "External VCS", actions: [{ id: "change.describe", title: "External describe", contexts: ["workspace", "revision", "ref"], fileContexts: ["file", "directory"], Form: Describe }], panels: [{ id: "details", title: "Custom info", icon: "Info", entryPoints: ["workspace", "command-center"], Component: Details }] }); }
`,
    );
    const previous = await client.getDaemonConfig();
    let externalProjectId: string | undefined;
    cleanupTasks.push({
      run: async () => {
        if (externalProjectId) await client.removeProject(externalProjectId);
        await client.removePlugin("vcs-ui-example").catch(() => undefined);
        await client.patchDaemonConfig({ pluginsEnabled: previous.config.pluginsEnabled });
        await client.close();
        await fixture.cleanup();
      },
    });
    await client.patchDaemonConfig({ pluginsEnabled: true });
    await client.installDirectoryPlugin(directory);
    const created = await client.createWorkspace({ source: { kind: "directory", path: repo } });
    if (!created.workspace) throw new Error(created.error ?? "Missing external VCS workspace");
    externalProjectId = created.workspace.projectId;
    const frames = await loadSessionMessageReaders();
    const snapshotRequests: string[] = [];
    page.on("websocket", (socket) => {
      socket.on("framesent", ({ payload }) => {
        const message = frames.client(payload);
        if (message?.type === "vcs.snapshot.get.request")
          snapshotRequests.push(message.workspaceId);
      });
    });
    await page.setViewportSize({ width: 1400, height: 900 });
    await page.goto(buildHostWorkspaceRoute(getServerId(), created.workspace.id));
    await expect(
      page.getByRole("button", { name: "Open Explorer sidebar", exact: true }),
    ).toBeVisible();
    await page.keyboard.press(`${process.platform === "darwin" ? "Meta" : "Control"}+Shift+G`);
    const panel = page.getByTestId("vcs-panel").filter({ visible: true });
    await expect(panel).toBeVisible();
    await expect(panel.getByText("External VCS · Working copy")).toBeVisible();
    await expect(panel.getByTestId("diff-file-0")).toHaveAccessibleName(/note\.txt/);
    await expect(panel.getByTestId("vcs-whitespace")).toHaveCount(0);
    await panel.getByTestId("vcs-comparison").click();
    await page.getByRole("button", { name: "Between revisions", exact: true }).click();
    await expect(panel.getByTestId("diff-file-0")).toHaveAccessibleName(/note\.txt/);
    await panel.getByTestId("vcs-whitespace").click();
    await expect(panel.getByTestId("diff-file-0")).toHaveCount(0);
    await panel.getByTestId("vcs-whitespace").click();
    await expect(panel.getByTestId("diff-file-0")).toHaveAccessibleName(/note\.txt/);
    await panel.getByTestId("vcs-comparison").click();
    await page.getByRole("button", { name: "Working copy", exact: true }).click();
    await expect(panel.getByTestId("vcs-whitespace")).toHaveCount(0);
    const initialSnapshots = snapshotRequests.length;
    expect(initialSnapshots).toBeGreaterThan(0);
    await page.getByTestId("workspace-header-menu-trigger").filter({ visible: true }).click();
    const describeMenuItem = page.getByTestId("workspace-vcs-action-change.describe");
    await expect(describeMenuItem).toBeEnabled();
    expect(snapshotRequests).toHaveLength(initialSnapshots);
    await writeFile(path.join(repo, ".external-vcs"), "Externally blocked");
    await expect(describeMenuItem).toBeDisabled();
    await expect(
      page.getByText("External operation in progress", { exact: true }).filter({ visible: true }),
    ).toBeVisible();
    await writeFile(path.join(repo, ".external-vcs"), "External initial");
    await expect(describeMenuItem).toBeEnabled();
    await page.keyboard.press("Escape");
    await writeFile(path.join(repo, ".external-vcs"), "External observed");
    await panel.getByTestId("vcs-view").click();
    await page.getByRole("button", { name: "History", exact: true }).last().click();
    await expect(panel.getByText("External observed", { exact: true })).toBeVisible({
      timeout: 15000,
    });
    await panel.getByTestId("vcs-view").click();
    await page.getByRole("button", { name: "Changes", exact: true }).last().click();
    const commands = await openCommandCenter(page);
    await commands.getByTestId("command-center-input").fill("External describe");
    await expect(commands.getByText("External describe", { exact: true })).toBeVisible();
    expect(snapshotRequests).toHaveLength(initialSnapshots);
    await writeFile(path.join(repo, ".external-vcs"), "Externally blocked");
    await expect(
      commands.getByText("External operation in progress", { exact: true }),
    ).toBeVisible();
    await writeFile(path.join(repo, ".external-vcs"), "External observed");
    await expect(commands.getByText("External operation in progress", { exact: true })).toHaveCount(
      0,
    );
    await commands.getByText("External describe", { exact: true }).click();
    await page.getByTestId("external-vcs-message").fill("Changed by extension");
    await page.getByTestId("external-vcs-submit").click();
    await expect(panel.getByTestId("vcs-operation")).toContainText("Operation completed");
    expect(await readFile(path.join(repo, ".external-vcs"), "utf8")).toBe("Changed by extension");
    await panel.getByTestId("diff-file-0").click({ button: "right" });
    await page.getByTestId("vcs-file-action-change.describe").click();
    await expect(page.getByTestId("external-selected-files")).toHaveText("note.txt");
    await page.getByTestId("external-vcs-submit").click();
    await expect(panel.getByTestId("vcs-operation")).toContainText("Operation completed");
    await page.getByTestId("workspace-header-menu-trigger").filter({ visible: true }).click();
    await page.getByTestId("workspace-vcs-view-plugin:details").click();
    await expect(panel.getByText("External panel: Changed by extension")).toBeVisible();
    await panel.getByTestId("external-vcs-custom-action").click();
    await expect
      .poll(() => readFile(path.join(repo, ".external-vcs"), "utf8"))
      .toBe("Changed from custom panel");
    await expect(panel.getByTestId("vcs-operation")).toContainText("Operation completed");
    const publishCommands = await openCommandCenter(page);
    await publishCommands.getByTestId("command-center-input").fill("Publish / PR/MR");
    await publishCommands.getByText("Publish / PR/MR", { exact: true }).click();
    await expect(panel.getByTestId("vcs-publish-remote")).toBeVisible();
    expect(await readFileIfPresent(path.join(repo, ".external-pushes"))).toBeNull();
    const panelCommands = await openCommandCenter(page);
    await panelCommands.getByTestId("command-center-input").fill("Custom info");
    await panelCommands.getByText("Custom info", { exact: true }).click();
    await expect(panel.getByText("External panel: Changed from custom panel")).toBeVisible();
    // Selecting another view survives reload instead of replaying the navigation request.
    await panel.getByTestId("vcs-view").click();
    await page.getByRole("button", { name: "History", exact: true }).last().click();
    await page.reload();
    await expect(panel.getByTestId("vcs-view")).toContainText("History");
    await page.getByTestId("workspace-header-menu-trigger").filter({ visible: true }).click();
    await page.getByTestId("workspace-vcs-view-publish").click();
    await panel.getByTestId("vcs-publish-remote").click();
    await page.getByRole("button", { name: /^origin/ }).click();
    await panel.getByTestId("vcs-publish-head").click();
    await page.getByRole("button", { name: "existing", exact: true }).click();
    await panel.getByTestId("vcs-publish-base").fill("main");
    await expect(panel.getByTestId("vcs-create-request")).toBeDisabled();
    await panel.getByTestId("vcs-find-request").click();
    await expect(panel.getByTestId("vcs-publication-status")).toContainText(
      "Existing external request",
    );
    await expect(panel.getByTestId("vcs-publication-status")).toContainText("Example check");
    expect(await readFileIfPresent(path.join(repo, ".external-pushes"))).toBeNull();
    await page
      .context()
      .route("https://github.com/paseo/vcs-ui/pull/8", (route) =>
        route.fulfill({ body: "Existing request" }),
      );
    const opened = page.waitForEvent("popup");
    await panel.getByTestId("vcs-open-request").click();
    const requestPage = await opened;
    await expect(requestPage).toHaveURL("https://github.com/paseo/vcs-ui/pull/8");
    await requestPage.close();
    await page.reload();
    await expect(panel.getByTestId("vcs-publish-head")).toContainText("existing", {
      timeout: 30_000,
    });
    await expect(panel.getByTestId("vcs-publish-title")).toHaveValue("");
    await expect(panel.getByTestId("vcs-publication-status")).toContainText(
      "Existing external request",
    );
    await panel.getByTestId("vcs-publish-head").click();
    await page.getByRole("button", { name: "task", exact: true }).click();
    await expect(panel.getByTestId("vcs-publication-status")).toHaveCount(0);
    await panel.getByTestId("vcs-find-request").click();
    await expect(panel.getByTestId("vcs-no-request")).toBeVisible();
    await expect(panel.getByTestId("vcs-open-request")).toHaveCount(0);
    expect(await readFileIfPresent(path.join(repo, ".external-pushes"))).toBeNull();
    await panel.getByTestId("vcs-publish-title").fill("External contribution");
    page.once("dialog", (dialog) => dialog.accept());
    await panel.getByTestId("vcs-create-request").click();
    await expect(panel.getByTestId("vcs-published-retry")).toBeVisible();
    await expect(panel.getByTestId("vcs-operation")).toContainText("Forge temporarily unavailable");
    expect(await readFile(path.join(repo, ".external-pushes"), "utf8")).toBe("1");
    await page.reload();
    await expect(panel.getByTestId("vcs-published-retry")).toBeVisible();
    await panel.getByTestId("vcs-retry-create").click();
    await expect(panel.getByTestId("vcs-operation")).toContainText("Operation completed");
    expect(await readFile(path.join(repo, ".external-pushes"), "utf8")).toBe("1");
    await panel.getByTestId("vcs-view").click();
    await page.getByRole("button", { name: "Create working copy", exact: true }).click();
    await panel.getByTestId("external-copy-label").fill("Created by external fields");
    await panel.getByTestId("vcs-copy-create").click();
    await expect(panel.getByTestId("vcs-copy-success")).toBeVisible();
    const copies = (await client.fetchWorkspaces()).entries.filter(
      (item) => item.projectId === externalProjectId && item.id !== created.workspace!.id,
    );
    expect(copies).toHaveLength(1);
    expect(await readFile(path.join(copies[0]!.workspaceDirectory, "note.txt"), "utf8")).toBe(
      "Created by external fields",
    );
    const changesUrl = page.url();
    await page.goto(
      buildNewWorkspaceRoute({
        serverId: getServerId(),
        projectId: externalProjectId!,
        sourceDirectory: repo,
      }),
    );
    await selectWorkspaceIsolation(page, "worktree");
    await expect(page.getByTestId("new-workspace-vcs-revision")).toHaveCount(0);
    await page.getByTestId("external-project-source").click();
    await page.getByTestId("workspace-create-submit").click();
    await expect(page).toHaveURL(/\/workspace\/wks_/);
    const projectCopies = (await client.fetchWorkspaces()).entries.filter(
      (item) =>
        item.projectId === externalProjectId &&
        item.id !== created.workspace!.id &&
        item.id !== copies[0]!.id,
    );
    expect(projectCopies).toHaveLength(1);
    expect(
      await readFile(path.join(projectCopies[0]!.workspaceDirectory, "note.txt"), "utf8"),
    ).toBe("Created by external project source");
    await page.goto(changesUrl);
    await client.disablePlugin("vcs-ui-example");
    await expect(panel.getByTestId("vcs-actions")).toHaveCount(0);
    await panel.getByTestId("vcs-refresh").click();
    await expect(panel.getByRole("alert")).toContainText("unavailable");
  },
);

for (const width of [1400, 390]) {
  test(`Git VCS stages files and commits the index at width ${width}`, async ({ page }) => {
    test.setTimeout(120_000);
    page.setDefaultTimeout(15_000);
    const { connectDaemonClient } = await import("../support/helpers/daemon-client-loader");
    const client = await connectDaemonClient<
      import("@getpaseo/client/internal/daemon-client").DaemonClient
    >({ clientIdPrefix: "git-vcs-ui" });
    const repo = await createTempGitRepo("git-vcs-ui-", {
      files: [{ path: "counter.ts", content: "export const count = 1;\n" }],
    });
    let projectId: string | undefined;
    let root: string | undefined;
    cleanupTasks.push({
      run: async () => {
        if (projectId) await client.removeProject(projectId);
        await client.close();
        if (root) {
          const { rm } = await import("node:fs/promises");
          await rm(root, { recursive: true, force: true });
        }
        await repo.cleanup();
      },
    });
    const project = await client.addProject(repo.path);
    if (!project.project) throw new Error(project.error ?? "Missing project");
    projectId = project.project.projectId;
    const created = await client.createWorkspace({ source: { kind: "working-copy", projectId } });
    if (!created.workspace?.workspaceDirectory)
      throw new Error(created.error ?? "Missing workspace");
    root = created.workspace.workspaceDirectory;
    execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: root });
    await writeFile(path.join(root, "counter.ts"), "export const count = 2;\n");
    await writeFile(path.join(root, "new.txt"), "untracked\n");
    await page.setViewportSize({ width, height: 900 });
    await configureDiffPresentation(page, {
      layout: "unified",
      wrapLines: false,
      inlineDiff: true,
    });
    await page.goto(buildHostWorkspaceRoute(getServerId(), created.workspace.id));
    await expect(
      page.getByTestId("workspace-header-menu-trigger").filter({ visible: true }),
    ).toBeVisible();
    if (width === 390) await page.reload();
    await page.getByTestId("workspace-header-menu-trigger").filter({ visible: true }).click();
    await page.getByTestId("workspace-vcs-action-stage").click();
    await expect(page.getByTestId("git-file-new.txt")).toBeVisible();
    await page.getByTestId("git-file-new.txt").getByRole("switch").click();
    await page.getByTestId("vcs-action-submit").click();
    const panel = page.getByTestId("vcs-panel").filter({ visible: true });
    await expect(panel.getByTestId("vcs-operation")).toContainText("Operation completed");
    expect(execFileSync("git", ["show", ":counter.ts"], { cwd: root, encoding: "utf8" })).toBe(
      "export const count = 2;\n",
    );
    expect(
      execFileSync("git", ["diff", "--cached", "--name-only"], {
        cwd: root,
        encoding: "utf8",
      }).trim(),
    ).toBe("counter.ts");
    await panel.getByTestId("vcs-comparison").click();
    await page.getByRole("button", { name: "Uncommitted", exact: true }).last().click();
    await saveVcsReview(page, panel, "Review from Git Changes");
    await writeFile(
      path.join(root, "counter.ts"),
      "export const count = 3;\nexport const extra = true;\n",
    );
    await expect(panel.getByTestId("diff-file-0")).toHaveAccessibleName("counter.ts, +2, -1");
    await expect(panel.getByText("Review from Git Changes", { exact: true })).toBeVisible();
    await panel.getByTestId("vcs-comparison").click();
    await page.getByRole("button", { name: "Staged", exact: true }).click();
    await expect(panel.getByTestId("diff-file-0")).toHaveAccessibleName("counter.ts, +1, -1");
    await panel.getByTestId("vcs-actions").first().click();
    await page.getByTestId("vcs-action-commit").click();
    await page.getByTestId("git-message").fill("Commit the index");
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByTestId("vcs-action-submit").click();
    await expect(panel.getByTestId("vcs-operation")).toContainText("Operation completed");
    expect(execFileSync("git", ["show", "HEAD:counter.ts"], { cwd: root, encoding: "utf8" })).toBe(
      "export const count = 2;\n",
    );
    expect(await readFile(path.join(root, "counter.ts"), "utf8")).toBe(
      "export const count = 3;\nexport const extra = true;\n",
    );
    await panel.getByTestId("vcs-comparison").click();
    await page.getByRole("button", { name: "Uncommitted", exact: true }).click();
    await panel.getByTestId("diff-file-0").click({ button: "right" });
    await expect(page.getByTestId("diff-file-0-copy-path")).toBeVisible();
    await expect(page.getByTestId("diff-file-0-download")).toBeVisible();
    await page.getByTestId("diff-file-0-duplicate").click();
    await expect
      .poll(() => readFileIfPresent(path.join(root!, "counter copy.ts")))
      .toBe("export const count = 3;\nexport const extra = true;\n");
    await expect(diffHeaderForPath(panel, "counter copy.ts")).toBeVisible();
    await diffHeaderForPath(panel, "counter.ts").click({ button: "right" });
    await page.getByTestId("vcs-file-action-discard").click();
    await expect(page.getByTestId("git-file-new.txt")).toHaveCount(0);
    await expect(page.getByTestId("git-file-counter.ts")).toBeVisible();
    await writeFile(path.join(root, "counter.ts"), "external edit\n");
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByTestId("vcs-action-submit").click();
    await expect(panel.getByTestId("vcs-operation")).toContainText("Repository changed");
    expect(await readFile(path.join(root, "counter.ts"), "utf8")).toBe("external edit\n");
    await expect(
      page.getByRole("alert").filter({ hasText: "Repository changed" }).last(),
    ).toBeVisible();
    await expect(page.getByTestId("git-file-counter.ts")).toBeVisible();
    await expect(page.getByTestId("vcs-action-submit")).toBeEnabled();
    await page
      .getByTestId("vcs-action-sheet")
      .getByRole("button", { name: "Close", exact: true })
      .click();
    await panel.getByTestId("vcs-view").click();
    await page.getByRole("button", { name: "History", exact: true }).last().click();
    await expect(panel.getByText("Commit the index", { exact: true })).toBeVisible();
    await expect(page.getByTestId("git-legacy-review")).toHaveCount(0);
    await expect(page.getByTestId("git-modern-vcs")).toHaveCount(0);
    await page.screenshot({ path: test.info().outputPath(`git-vcs-${width}.png`) });
  });
}

test("Git working-copy fields validate and create the requested branch", async ({ page }) => {
  const { connectDaemonClient } = await import("../support/helpers/daemon-client-loader");
  const client = await connectDaemonClient<
    import("@getpaseo/client/internal/daemon-client").DaemonClient
  >({ clientIdPrefix: "git-copy-fields" });
  const repo = await createTempGitRepo("git-copy-fields-");
  let projectId: string | undefined;
  cleanupTasks.push({
    run: async () => {
      if (projectId) await client.removeProject(projectId);
      await client.close();
      await repo.cleanup();
    },
  });
  const source = await client.createWorkspace({ source: { kind: "directory", path: repo.path } });
  if (!source.workspace) throw new Error(source.error ?? "Missing Git workspace");
  projectId = source.workspace.projectId;
  await page.goto(buildHostWorkspaceRoute(getServerId(), source.workspace.id));
  await page.getByTestId("workspace-header-menu-trigger").filter({ visible: true }).click();
  await page.getByTestId("workspace-vcs-view-working-copy").click();
  const panel = page.getByTestId("vcs-panel").filter({ visible: true });
  await panel.getByTestId("git-working-copy-branch").fill("../invalid");
  await panel.getByTestId("vcs-copy-create").click();
  await expect(panel.getByRole("alert")).toContainText("Enter a valid branch name.");
  expect(
    (await client.fetchWorkspaces()).entries.filter((item) => item.projectId === projectId),
  ).toHaveLength(1);
  await panel.getByTestId("git-working-copy-branch").fill("feature/from-plugin-fields");
  await panel.getByTestId("vcs-copy-create").click();
  await expect(panel.getByTestId("vcs-copy-success")).toBeVisible();
  const copies = (await client.fetchWorkspaces()).entries.filter(
    (item) => item.projectId === projectId && item.id !== source.workspace!.id,
  );
  expect(copies).toHaveLength(1);
  expect(
    execFileSync("git", ["branch", "--show-current"], {
      cwd: copies[0]!.workspaceDirectory,
      encoding: "utf8",
    }).trim(),
  ).toBe("feature/from-plugin-fields");
});

test("Git comparison settings persist project defaults and workspace overrides", async ({
  page,
}) => {
  const workspace = await createWorkspaceWithCommittedDiff();
  await openWorkspaceChangesSurface(page, workspace, 30_000);
  const toggle = page.getByTestId("working-diff-panel").getByTestId("vcs-comparison-settings");
  await toggle.click();
  await page.getByTestId("vcs-comparison-settings-scope").click();
  await page.getByRole("button", { name: "Project", exact: true }).click();
  await page.getByTestId("git-comparison-settings-mode").click();
  await page.getByRole("button", { name: "Uncommitted", exact: true }).click();
  await page.getByTestId("vcs-comparison-settings-save").click();
  await expect(page.getByText("Settings saved", { exact: true })).toBeVisible();
  await page.getByTestId("vcs-comparison-settings-scope").click();
  await page.getByRole("button", { name: "Workspace", exact: true }).click();
  await expect(page.getByTestId("git-comparison-settings-mode")).toContainText("Uncommitted");
  await page.getByTestId("git-comparison-settings-mode").click();
  await page.getByRole("button", { name: "All changes", exact: true }).click();
  await page.getByTestId("vcs-comparison-settings-save").click();
  await expect(page.getByText("Settings saved", { exact: true })).toBeVisible();
  await page.reload();
  await expect(toggle).toBeVisible();
  await toggle.click();
  await expect(page.getByTestId("git-comparison-settings-mode")).toContainText("All changes");
  await page.getByTestId("vcs-comparison-settings-reset").click();
  await expect(page.getByTestId("git-comparison-settings-mode")).toContainText("Uncommitted");
});

for (const width of [1400, 390]) {
  for (const scenario of ["split", "squash", ...(width === 390 ? ["split-reconnect"] : [])]) {
    const action = scenario === "split-reconnect" ? "split" : scenario;
    test(`jj ${scenario} file selection and bookmark forms at width ${width}`, async ({ page }) => {
      test.setTimeout(120_000);
      const { connectDaemonClient } = await import("../support/helpers/daemon-client-loader");
      const client = await connectDaemonClient<
        import("@getpaseo/client/internal/daemon-client").DaemonClient
      >({ clientIdPrefix: "jj-file-actions-ui" });
      const repo = await createTempGitRepo("jj-file-actions-ui-", {
        files: [{ path: "base.txt", content: "base\n" }],
      });
      execFileSync("jj", ["git", "init", "--colocate", repo.path], { stdio: "pipe" });
      let root: string | undefined;
      let projectId: string | undefined;
      cleanupTasks.push({
        run: async () => {
          if (projectId) await client.removeProject(projectId);
          await client.close();
          if (root) {
            const { rm } = await import("node:fs/promises");
            await rm(root, { recursive: true, force: true });
          }
          await repo.cleanup();
        },
      });
      const project = await client.addProject(repo.path);
      if (!project.project) throw new Error(project.error ?? "Missing project");
      projectId = project.project.projectId;
      const created = await client.createWorkspace({ source: { kind: "working-copy", projectId } });
      if (!created.workspace?.workspaceDirectory)
        throw new Error(created.error ?? "Missing workspace");
      root = created.workspace.workspaceDirectory;
      const jj = (...args: string[]) =>
        execFileSync("jj", args, { cwd: root, encoding: "utf8" }).trim();
      jj("describe", "-r", "@-", "-m", "Destination for files");
      await writeFile(path.join(root, "selected (file).txt"), "selected\n");
      await writeFile(path.join(root, "remaining.txt"), "remaining\n");
      jj("describe", "-m", "Source for files");
      const original = jj("log", "--no-graph", "-r", "@", "-T", "commit_id");
      const destination = jj("log", "--no-graph", "-r", "@-", "-T", "commit_id");
      let disconnectReply: (() => void) | null = null;
      let intercepted = false;
      let executions = 0;
      if (scenario === "split-reconnect") {
        const frames = await loadSessionMessageReaders();
        await page.routeWebSocket(daemonWsRoutePattern(), (browser) => {
          const server = browser.connectToServer();
          browser.onMessage((frame) => {
            const message = frames.client(frame);
            if (message?.type === "vcs.actions.execute.request" && message.action === action)
              executions++;
            server.send(frame);
          });
          server.onMessage((frame) => {
            if (!intercepted && frames.server(frame)?.type === "vcs.actions.execute.response") {
              intercepted = true;
              disconnectReply = () => {
                browser.close({ code: 1012, reason: "Test lost acknowledgement" });
                server.close();
              };
              return;
            }
            browser.send(frame);
          });
        });
      }
      await page.setViewportSize({ width, height: 900 });
      await page.goto(buildHostWorkspaceRoute(getServerId(), created.workspace.id));
      await expect(
        page.getByRole("button", { name: "Open Explorer sidebar", exact: true }),
      ).toBeVisible();
      if (width === 390) {
        await page.reload();
        await page.getByTestId("workspace-explorer-toggle").first().click();
        await page.getByTestId("workspace-tab-changes_tree").filter({ visible: true }).click();
      } else {
        await page.keyboard.press(`${process.platform === "darwin" ? "Meta" : "Control"}+Shift+G`);
      }
      const panel = page.getByTestId("vcs-panel").filter({ visible: true });
      await expect(panel).toBeVisible({ timeout: 30_000 });
      if (width === 390)
        await page
          .getByRole("button", { name: "Close Explorer sidebar", exact: true })
          .last()
          .click();
      const openAction = async (id: string) => {
        await page.getByTestId("workspace-header-menu-trigger").filter({ visible: true }).click();
        await page.getByTestId(`workspace-vcs-action-${id}`).click();
        await expect(page.getByTestId("vcs-action-submit")).toBeVisible();
      };
      const closeAction = () =>
        page
          .getByTestId("vcs-action-sheet")
          .getByRole("button", { name: "Close", exact: true })
          .click();
      await openAction(action);
      await page.getByRole("switch", { name: "remaining.txt", exact: true }).click();
      await page.getByRole("switch", { name: "selected (file).txt", exact: true }).click();
      await expect(page.getByTestId("vcs-action-submit")).toBeDisabled();
      await page.getByRole("switch", { name: "selected (file).txt", exact: true }).click();
      if (action === "squash") {
        await page.getByTestId("jj-destination").click();
        await page.getByRole("button", { name: /Destination for files/ }).click();
      } else await page.getByTestId("jj-message").fill("Extracted file");
      let preview = "";
      page.once("dialog", async (dialog) => {
        preview = dialog.message();
        await dialog.dismiss();
      });
      await page.getByTestId("vcs-action-submit").click();
      await expect(page.getByTestId("vcs-action-submit")).toBeEnabled();
      expect(preview).toContain("selected (file).txt");
      expect(preview).not.toContain("remaining.txt");
      expect(jj("log", "--no-graph", "-r", "@", "-T", "commit_id")).toBe(original);
      page.once("dialog", (dialog) => dialog.accept());
      await page.getByTestId("vcs-action-submit").click();
      if (scenario === "split-reconnect") {
        await expect.poll(() => intercepted).toBe(true);
        await expect(page.getByTestId("vcs-action-submit")).toBeDisabled();
        await expect(page.getByTestId("jj-message")).not.toBeEditable();
        disconnectReply!();
      }
      await expect(page.getByTestId("vcs-action-sheet")).toBeHidden({ timeout: 30_000 });
      if (scenario === "split-reconnect") expect(executions).toBe(1);
      await expect.poll(() => jj("diff", "--name-only", "-r", "@")).toBe("remaining.txt");
      expect(jj("file", "show", "-r", "@-", 'root-file:"selected (file).txt"')).toBe("selected");

      await openAction("bookmark-create");
      await page.getByTestId("jj-name").fill("topic@review");
      await page.getByTestId("vcs-action-submit").click();
      await expect(page.getByTestId("vcs-action-sheet")).toBeHidden();
      const current = jj("log", "--no-graph", "-r", "@", "-T", "commit_id");
      await expect
        .poll(() => jj("log", "--no-graph", "-r", '"topic@review"', "-T", "commit_id"))
        .toBe(current);
      await openAction("bookmark-create");
      await page.getByTestId("jj-name").fill("topic@review");
      await page.getByTestId("vcs-action-submit").click();
      await expect(
        page
          .getByRole("alert")
          .filter({ hasText: /already exists/i })
          .last(),
      ).toBeVisible();
      await expect(page.getByTestId("jj-name")).toHaveValue("topic@review");
      await expect(page.getByTestId("vcs-action-submit")).toBeEnabled();
      await page.screenshot({
        path: test.info().outputPath(`jj-${action}-bookmark-error-${width}.png`),
      });
      await closeAction();
      jj("bookmark", "set", "--allow-backwards", '"topic@review"', "-r", destination);
      // Wait for observation before opening the form, which pins its snapshot.
      await page.reload();
      await expect(panel).toBeVisible({ timeout: 30_000 });
      await openAction("bookmark-set");
      await page.getByTestId("jj-name").click();
      await page.getByRole("button", { name: "topic@review", exact: true }).click();
      page.once("dialog", async (dialog) => {
        preview = dialog.message();
        await dialog.accept();
      });
      await page.getByTestId("vcs-action-submit").click();
      await expect(page.getByTestId("vcs-action-sheet")).toBeHidden();
      expect(preview).toContain(destination);
      expect(preview).toContain(current);
      await expect
        .poll(() => jj("log", "--no-graph", "-r", '"topic@review"', "-T", "commit_id"))
        .toBe(current);
    });
  }
}

for (const width of [1400, 390]) {
  test(`jj remote bookmark lifecycle and push reconnect at width ${width}`, async ({ page }) => {
    test.setTimeout(180_000);
    page.setDefaultTimeout(15_000);
    const { connectDaemonClient } = await import("../support/helpers/daemon-client-loader");
    const client = await connectDaemonClient<
      import("@getpaseo/client/internal/daemon-client").DaemonClient
    >({ clientIdPrefix: "jj-remote-ui" });
    const repo = await createTempGitRepo("jj-remote-ui-", {
      files: [{ path: "base.txt", content: "base\n" }],
    });
    const jj = (...args: string[]) =>
      execFileSync("jj", args, {
        cwd: repo.path,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    execFileSync("jj", ["git", "init", "--colocate", repo.path]);
    jj("config", "set", "--repo", "user.name", "UI Test");
    jj("config", "set", "--repo", "user.email", "ui@example.test");
    jj("config", "set", "--repo", "git.auto-local-bookmark", "false");
    const remote = path.join(repo.path, ".jj", "remote.git");
    execFileSync("git", ["init", "--bare", remote], { stdio: "pipe" });
    const base = jj("log", "--no-graph", "-r", "@-", "-T", "commit_id");
    execFileSync("git", ["-C", repo.path, "push", remote, `${base}:refs/heads/topic@review`], {
      stdio: "pipe",
    });
    jj("git", "remote", "add", "origin", remote);
    jj("git", "remote", "add", "offline", path.join(repo.path, ".jj", "missing.git"));
    await writeFile(path.join(repo.path, "publish.txt"), "published\n");
    jj("describe", "-m", "Publish selected bookmark");
    const revision = jj("log", "--no-graph", "-r", "@", "-T", "commit_id");
    let projectId: string | undefined;
    cleanupTasks.push({
      run: async () => {
        if (projectId) await client.removeProject(projectId);
        await client.close();
        await repo.cleanup();
      },
    });
    const created = await client.createWorkspace({
      source: { kind: "directory", path: repo.path },
    });
    if (!created.workspace) throw new Error(created.error ?? "Missing workspace");
    projectId = created.workspace.projectId;
    let dropPushReply = false;
    let disconnectReply: (() => void) | null = null;
    let pushRequests = 0;
    const frames = await loadSessionMessageReaders();
    await page.routeWebSocket(daemonWsRoutePattern(), (browser) => {
      const server = browser.connectToServer();
      browser.onMessage((frame) => {
        const message = frames.client(frame);
        if (message?.type === "vcs.actions.execute.request" && message.action === "push")
          pushRequests++;
        server.send(frame);
      });
      server.onMessage((frame) => {
        if (dropPushReply && frames.server(frame)?.type === "vcs.actions.execute.response") {
          dropPushReply = false;
          disconnectReply = () => {
            browser.close({ code: 1012, reason: "Lost push reply" });
            server.close();
          };
          return;
        }
        browser.send(frame);
      });
    });
    await page.setViewportSize({ width, height: 900 });
    await page.goto(buildHostWorkspaceRoute(getServerId(), created.workspace.id));
    const panel = page.getByTestId("vcs-panel").filter({ visible: true });
    const menu = async () =>
      page.getByTestId("workspace-header-menu-trigger").filter({ visible: true }).click();
    await expect(
      page.getByRole("button", { name: "Open Explorer sidebar", exact: true }),
    ).toBeVisible();
    if (width === 390) {
      await page.reload();
      await page.getByTestId("workspace-explorer-toggle").first().click();
      await page.getByTestId("workspace-tab-changes_tree").filter({ visible: true }).click();
    } else {
      await page.keyboard.press(`${process.platform === "darwin" ? "Meta" : "Control"}+Shift+G`);
    }
    await expect(panel).toBeVisible();
    if (width === 390)
      await page
        .getByRole("button", { name: "Close Explorer sidebar", exact: true })
        .last()
        .click();
    const openAction = async (id: string) => {
      await menu();
      await page.getByTestId(`workspace-vcs-action-${id}`).click();
      await expect(page.getByTestId("vcs-action-submit")).toBeVisible();
    };
    const select = async (field: string, label: string) => {
      await page.getByTestId(`jj-${field}`).click();
      await page.getByRole("button", { name: label, exact: true }).click();
    };
    const apply = async () => {
      await page.getByTestId("vcs-action-submit").click();
      await expect(page.getByTestId("vcs-action-sheet")).toBeHidden();
    };
    const close = () =>
      page
        .getByTestId("vcs-action-sheet")
        .getByRole("button", { name: "Close", exact: true })
        .click();
    const refAction = async (label: string, action: string) => {
      await panel
        .getByText(label, { exact: true })
        .locator("..")
        .locator("..")
        .getByTestId("vcs-actions")
        .click();
      await page.getByTestId(`vcs-action-${action}`).click();
    };
    await openAction("fetch");
    await expect(page.getByTestId("vcs-action-submit")).toBeDisabled();
    await select("remote", "offline");
    await page.getByTestId("vcs-action-submit").click();
    await expect(
      page
        .getByRole("alert")
        .filter({ hasText: /missing.git/ })
        .last(),
    ).toBeVisible();
    await expect(page.getByTestId("jj-remote")).toContainText("offline");
    await select("remote", "origin");
    await apply();
    await panel.getByTestId("vcs-view").click();
    await page.getByRole("button", { name: "References", exact: true }).click();
    await expect(panel.getByText("topic@review@origin", { exact: true })).toBeVisible();
    await expect(panel.getByText("topic@review", { exact: true })).toHaveCount(0);
    await refAction("topic@review@origin", "bookmark-track");
    await expect(page.getByTestId("jj-remote")).toContainText("origin");
    await select("name", "topic@review");
    await select("remote", "offline");
    await page.getByTestId("vcs-action-submit").click();
    await expect(
      page.getByRole("alert").filter({ hasText: "Remote bookmark no longer exists" }).last(),
    ).toBeVisible();
    await expect(page.getByTestId("jj-name")).toContainText("topic@review");
    await select("remote", "origin");
    await apply();
    await expect(panel.getByText("topic@review", { exact: true })).toBeVisible();

    await refAction("topic@review", "bookmark-delete");
    let preview = "";
    page.once("dialog", async (dialog) => {
      preview = dialog.message();
      await dialog.dismiss();
    });
    await page.getByTestId("vcs-action-submit").click();
    await expect(page.getByTestId("vcs-action-submit")).toBeEnabled();
    expect(preview).toContain("topic@review");
    expect(preview).toContain(base);
    expect(
      jj("log", "--ignore-working-copy", "--no-graph", "-r", '"topic@review"', "-T", "commit_id"),
    ).toBe(base);
    jj("bookmark", "create", "concurrent", "-r", revision);
    jj("bookmark", "delete", "concurrent");
    await page.getByTestId("vcs-action-submit").click();
    await expect(
      page.getByRole("alert").filter({ hasText: "Repository changed" }).last(),
    ).toBeVisible();
    await close();
    await refAction("topic@review", "bookmark-delete");
    page.once("dialog", (dialog) => dialog.accept());
    await apply();
    await expect(panel.getByText("topic@review", { exact: true })).toHaveCount(0);
    // Deletion is local until an explicit push.
    expect(
      execFileSync("git", ["--git-dir", remote, "rev-parse", "refs/heads/topic@review"], {
        encoding: "utf8",
      }).trim(),
    ).toBe(base);
    jj("bookmark", "set", '"topic@review"', "-r", revision);
    jj("bookmark", "create", "keep-local", "-r", revision);
    await page.reload();
    await expect(panel.getByText("keep-local", { exact: true })).toBeVisible();
    await openAction("push");
    await select("name", "topic@review");
    await select("remote", "origin");
    await rename(remote, `${remote}.away`);
    await page.getByTestId("vcs-action-submit").click();
    await expect(
      page
        .getByRole("alert")
        .filter({ hasText: /remote.git/ })
        .last(),
    ).toBeVisible();
    await expect(page.getByTestId("jj-name")).toContainText("topic@review");
    await rename(`${remote}.away`, remote);
    dropPushReply = true;
    await page.getByTestId("vcs-action-submit").click();
    await expect.poll(() => disconnectReply !== null).toBe(true);
    await expect(page.getByTestId("vcs-action-submit")).toBeDisabled();
    disconnectReply!();
    await expect(page.getByTestId("vcs-action-sheet")).toBeHidden({ timeout: 30_000 });
    expect(pushRequests).toBe(2);
    await expect(panel.getByTestId("vcs-operation")).toContainText("Operation completed");
    await expect(panel.getByText("Lost push reply", { exact: true })).toHaveCount(0);
    expect(
      execFileSync("git", ["--git-dir", remote, "rev-parse", "refs/heads/topic@review"], {
        encoding: "utf8",
      }).trim(),
    ).toBe(revision);
    expect(
      execFileSync(
        "git",
        ["--git-dir", remote, "for-each-ref", "--format=%(refname)", "refs/heads"],
        { encoding: "utf8" },
      ).trim(),
    ).toBe("refs/heads/topic@review");
    await page.screenshot({ path: test.info().outputPath(`jj-remote-bookmarks-${width}.png`) });
  });
}

const jjPublicationTest = test.extend({
  e2eDaemonEnvironment: [
    async ({ e2eDaemonConfig }, provide) => {
      void e2eDaemonConfig;
      const { mkdtemp, rm } = await import("node:fs/promises");
      const { tmpdir } = await import("node:os");
      const directory = await mkdtemp(path.join(tmpdir(), "jj-forge-ui-"));
      const script = `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const gitlab = path.basename(process.argv[1]) === "glab";
const statePath = path.join(process.cwd(), ".jj", "forge-state.json");
if (fs.existsSync(statePath)) {
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  const save = () => fs.writeFileSync(statePath, JSON.stringify(state));
  const respond = value => { process.stdout.write(JSON.stringify(value)); process.exit(0); };
  const fail = text => { process.stderr.write(text); process.exit(1); };
  fs.appendFileSync(path.join(process.cwd(), ".jj", "forge-reads"), JSON.stringify(args) + "\\n");
  const action = gitlab
    ? args.includes("cancel_merge_when_pipeline_succeeds") || args.some(arg => arg.endsWith("/cancel_merge_when_pipeline_succeeds")) ? "disable" : args[0] === "mr" && args[1] === "merge" ? args.includes("--auto-merge") ? "enable" : "merge" : null
    : args[0] === "pr" && args[1] === "merge" ? args.includes("--disable-auto") ? "disable" : args.includes("--auto") ? "enable" : "merge" : null;
  if (action) {
    fs.appendFileSync(path.join(process.cwd(), ".jj", "forge-actions"), JSON.stringify({ action, args }) + "\\n");
    if (state.failAction) fail("Forge action temporarily unavailable");
    if (action === "merge") state.merged = true;
    else state.auto = action === "enable";
    save();
    if (state.holdAction) {
      const timer = setInterval(() => {
        if (!fs.existsSync(path.join(process.cwd(), ".jj", "release-action"))) return;
        clearInterval(timer); respond({});
      }, 25);
    } else respond({});
  } else {
    const statusRead = gitlab ? args[0] === "mr" && ["list", "view"].includes(args[1]) : args[0] === "pr" && ["list", "view"].includes(args[1]);
    if (statusRead && state.failStatus) fail("Forge status temporarily unavailable");
    const url = gitlab ? "https://gitlab.com/paseo/vcs-ui/-/merge_requests/7" : "https://github.com/paseo/vcs-ui/pull/7";
    const branch = args[args.indexOf(gitlab ? "--source-branch" : "--head") + 1];
    if (gitlab) {
      const mr = { iid: state.number || 7, title: "Existing jj review", web_url: url, state: state.merged ? "merged" : "opened", source_branch: "topic", target_branch: "main", sha: state.revision, source_project_id: 1, target_project_id: 1, draft: false, work_in_progress: false, has_conflicts: false, merged_at: state.merged ? "2026-11-09T00:00:00Z" : null, detailed_merge_status: "mergeable", merge_status: "can_be_merged", merge_when_pipeline_succeeds: !!state.auto, references: { full: "paseo/vcs-ui!7" }, head_pipeline: { id: 10, status: state.check === "pending" ? "running" : state.check === "failure" ? "failed" : "success" } };
      if (args[0] === "mr" && args[1] === "list") respond(branch === "topic" ? [mr] : []);
      if (args[0] === "mr" && args[1] === "view") respond(mr);
      if (args[0] === "ci" && args[1] === "get") respond({ id: 10, status: mr.head_pipeline.status, jobs: [{ id: 11, name: "Review checks", stage: "test", status: mr.head_pipeline.status, web_url: url + "/checks" }] });
      if (args.some(arg => arg.endsWith("/approvals"))) respond({ approvals_required: 0, approvals_left: 0, approved_by: [] });
    } else {
      const pr = { number: state.number || 7, url, title: "Existing jj review", state: state.merged ? "MERGED" : "OPEN", baseRefName: "main", headRefName: "topic", headRefOid: state.revision, headRepositoryOwner: { login: "paseo" }, mergeable: "MERGEABLE", isDraft: false, mergedAt: state.merged ? "2026-11-09T00:00:00Z" : null, statusCheckRollup: [{ __typename: "StatusContext", context: "Review checks", state: state.check === "pending" ? "PENDING" : state.check === "failure" ? "FAILURE" : "SUCCESS" }] };
      if (args[0] === "pr" && args[1] === "view") fail("no pull requests found");
      if (args[0] === "pr" && args[1] === "list") respond(branch === "topic" ? [pr] : []);
      if (args[0] === "api" && args[1] === "graphql") respond({ data: { repository: { autoMergeAllowed: true, mergeCommitAllowed: true, squashMergeAllowed: true, rebaseMergeAllowed: true, viewerDefaultMergeMethod: "SQUASH", pullRequest: { mergeStateStatus: state.check === "pending" ? "BLOCKED" : "CLEAN", autoMergeRequest: state.auto ? { enabledAt: "2026-11-09T00:00:00Z", mergeMethod: "SQUASH", enabledBy: { login: "paseo" } } : null, viewerCanEnableAutoMerge: true, viewerCanDisableAutoMerge: true, viewerCanMergeAsAdmin: false, viewerCanUpdateBranch: true, isMergeQueueEnabled: false, isInMergeQueue: false } } } });
    }
    if (args[0] === "repo" && args[1] === "view") respond({ name: "vcs-ui", owner: { login: "paseo" } });
    respond([]);
  }
  return;
}
const creating = gitlab ? args[0] === "mr" && args[1] === "create" : args.includes("POST") && args.some(arg => arg.endsWith("/pulls"));
if (creating) {
  const log = path.join(process.cwd(), ".jj", "forge-creates");
  const previous = fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "";
  fs.appendFileSync(log, JSON.stringify(args) + "\\n");
  if (!previous) { process.stderr.write("Forge temporarily unavailable"); process.exit(1); }
  if (gitlab) process.stdout.write("https://gitlab.com/paseo/vcs-ui/-/merge_requests/7");
  else process.stdout.write(JSON.stringify({ url: "https://api.github.com/repos/paseo/vcs-ui/pulls/7", html_url: "https://github.com/paseo/vcs-ui/pull/7", number: 7 }));
} else if (args[0] === "pr" && args[1] === "view") { process.stderr.write("no pull requests found"); process.exit(1); }
else if (args[0] === "repo" && args[1] === "view") process.stdout.write(JSON.stringify({ name: "vcs-ui", owner: { login: "paseo" } }));
else if (args[0] === "api" && args[1] === "graphql") { process.stderr.write("Optional facts unavailable"); process.exit(1); }
else process.stdout.write("[]");
`;
      await writeFile(path.join(directory, "gh"), script, { mode: 0o755 });
      await writeFile(path.join(directory, "glab"), script, { mode: 0o755 });
      try {
        await provide({ PATH: directory + path.delimiter + process.env.PATH });
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
    { scope: "worker" },
  ],
});

async function createJjPublicationWorkspace(forge: string) {
  const { connectDaemonClient } = await import("../support/helpers/daemon-client-loader");
  const client = await connectDaemonClient<
    import("@getpaseo/client/internal/daemon-client").DaemonClient
  >({ clientIdPrefix: "jj-publication-ui" });
  const repo = await createTempGitRepo("jj-publication-ui-", {
    files: [{ path: "base.txt", content: "base\n" }],
  });
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: repo.path,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  const jj = (...args: string[]) =>
    execFileSync("jj", args, {
      cwd: repo.path,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  jj("git", "init", "--colocate");
  jj("config", "set", "--repo", "user.name", "UI Test");
  jj("config", "set", "--repo", "user.email", "ui@example.test");
  const remote = path.join(repo.path, ".jj", "remote.git");
  git("init", "--bare", remote);
  git("push", remote, "HEAD:refs/heads/main", "HEAD:refs/heads/topic");
  const pushes = path.join(repo.path, ".jj", "pushes");
  const transport = path.join(repo.path, ".jj", "local-ssh");
  // Real pack transfer over local pipes; no hosted Git service or credentials.
  await writeFile(
    transport,
    `#!${process.execPath}
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
if (args.includes("-G")) process.exit(0);
const command = args[args.length - 1] || "";
const receiving = command.startsWith("git-receive-pack");
if (!receiving && !command.startsWith("git-upload-pack")) process.exit(1);
if (receiving) fs.appendFileSync(${JSON.stringify(pushes)}, "push\\n");
const child = spawnSync(receiving ? "git-receive-pack" : "git-upload-pack", [${JSON.stringify(remote)}], { stdio: "inherit" });
process.exit(child.status ?? 1);
`,
    { mode: 0o755 },
  );
  git("config", "core.sshCommand", transport);
  git("remote", "add", "origin", `git@${forge}.com:paseo/vcs-ui.git`);
  jj("git", "fetch", "--remote", "origin");
  jj("bookmark", "track", "topic@origin");
  await writeFile(path.join(repo.path, "published.txt"), "selected revision\n");
  jj("describe", "-m", "Ready for review");
  jj("bookmark", "set", "topic", "-r", "@");
  jj("bookmark", "create", "keep-local", "-r", "@");
  const revision = jj("log", "--no-graph", "-r", "@", "-T", "commit_id");
  let projectId: string | undefined;
  cleanupTasks.push({
    run: async () => {
      if (projectId) await client.removeProject(projectId);
      await client.close();
      await repo.cleanup();
    },
  });
  const created = await client.createWorkspace({
    source: { kind: "directory", path: repo.path },
  });
  if (!created.workspace) throw new Error(created.error ?? "Missing workspace");
  projectId = created.workspace.projectId;
  return {
    client,
    repo,
    git,
    jj,
    remote,
    pushes,
    revision,
    created: { ...created, workspace: created.workspace },
  };
}

for (const forge of ["github", "gitlab"]) {
  for (const width of [1400, 390]) {
    jjPublicationTest(
      `jj ${forge} retries request creation without republishing at width ${width}`,
      async ({ page }) => {
        test.setTimeout(150_000);
        page.setDefaultTimeout(15_000);
        const { repo, git, remote, pushes, revision, created } =
          await createJjPublicationWorkspace(forge);
        await page.setViewportSize({ width, height: 900 });
        await page.goto(buildHostWorkspaceRoute(getServerId(), created.workspace.id));
        await page.getByTestId("workspace-header-menu-trigger").filter({ visible: true }).click();
        await page.getByTestId("workspace-vcs-view-publish").click();
        const panel = page.getByTestId("vcs-panel").filter({ visible: true });
        await panel.getByTestId("vcs-publish-remote").getByRole("button").click();
        await page.getByRole("button", { name: "origin", exact: true }).click();
        await panel.getByTestId("vcs-publish-head").getByRole("button").click();
        await page.getByRole("button", { name: "topic", exact: true }).click();
        await panel.getByTestId("vcs-publish-base").fill("main");
        await panel.getByTestId("vcs-publish-title").fill("Review selected jj bookmark");
        await panel.getByTestId("vcs-publish-body").fill("Preserve this description after retry");
        page.once("dialog", (dialog) => dialog.accept());
        await panel.getByTestId("vcs-create-request").click();
        await expect(panel.getByTestId("vcs-published-retry")).toBeVisible();
        await expect(panel.getByTestId("vcs-operation")).toContainText(
          "Forge temporarily unavailable",
        );
        expect(git("--git-dir", remote, "rev-parse", "refs/heads/topic")).toBe(revision);
        expect(git("--git-dir", remote, "for-each-ref", "--format=%(refname)", "refs/heads")).toBe(
          "refs/heads/main\nrefs/heads/topic",
        );
        expect(await readFile(pushes, "utf8")).toBe("push\n");
        const log = path.join(repo.path, ".jj", "forge-creates");
        const attempts = async () =>
          (await readFile(log, "utf8"))
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line) as string[]);
        expect(await attempts()).toHaveLength(1);
        await page.screenshot({
          path: test.info().outputPath(`jj-${forge}-published-retry-${width}.png`),
        });
        await page.reload();
        await expect(panel.getByTestId("vcs-published-retry")).toBeVisible();
        await expect(panel.getByTestId("vcs-publish-title")).toHaveValue(
          "Review selected jj bookmark",
        );
        await expect(panel.getByTestId("vcs-publish-body")).toHaveValue(
          "Preserve this description after retry",
        );
        await panel.getByTestId("vcs-retry-create").click();
        await expect(panel.getByTestId("vcs-operation")).toContainText("Operation completed");
        await expect(panel.getByTestId("vcs-published-retry")).toHaveCount(0);
        expect(await readFile(pushes, "utf8")).toBe("push\n");
        expect(git("--git-dir", remote, "rev-parse", "refs/heads/topic")).toBe(revision);
        const calls = await attempts();
        expect(calls).toHaveLength(2);
        expect(calls[1]).toEqual(calls[0]);
      },
    );
  }
}

for (const forge of ["github", "gitlab"]) {
  for (const width of [1400, 390]) {
    jjPublicationTest(
      `jj ${forge} review status, forge actions and reconnect at width ${width}`,
      async ({ page }) => {
        test.setTimeout(240_000);
        page.setDefaultTimeout(15_000);
        const { repo, jj, git, pushes, revision, created } =
          await createJjPublicationWorkspace(forge);
        jj("git", "push", "--remote", "origin", "--bookmark", "topic");
        await unlink(pushes);
        git("remote", "add", "review", git("remote", "get-url", "origin"));
        const statePath = path.join(repo.path, ".jj", "forge-state.json");
        const patch = async (value: Record<string, unknown>) => {
          const previous = JSON.parse((await readFileIfPresent(statePath)) ?? "{}");
          await writeFile(statePath, JSON.stringify({ ...previous, ...value }));
        };
        await patch({ revision, check: "pending" });
        const actions = async () =>
          ((await readFileIfPresent(path.join(repo.path, ".jj", "forge-actions"))) ?? "")
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line) as { action: string; args: string[] });
        const frames = await loadSessionMessageReaders();
        let disconnect: (() => void) | undefined;
        let dropReply = false;
        let holdStatusReply = false;
        let releaseStatusReply: (() => void) | undefined;
        let executeRequests = 0;
        await page.routeWebSocket(daemonWsRoutePattern(), (browser) => {
          const server = browser.connectToServer();
          disconnect = () => {
            browser.close({ code: 1012, reason: "Review reconnect" });
            server.close();
          };
          browser.onMessage((frame) => {
            if (frames.client(frame)?.type === "vcs.change-request.execute.request")
              executeRequests++;
            server.send(frame);
          });
          server.onMessage((frame) => {
            if (
              holdStatusReply &&
              frames.server(frame)?.type === "vcs.change-request.get.response"
            ) {
              holdStatusReply = false;
              releaseStatusReply = () => browser.send(frame);
              return;
            }
            if (dropReply && frames.server(frame)?.type === "vcs.change-request.execute.response") {
              dropReply = false;
              return;
            }
            browser.send(frame);
          });
        });
        await page.setViewportSize({ width, height: 900 });
        await page.goto(buildHostWorkspaceRoute(getServerId(), created.workspace.id));
        await page.getByTestId("workspace-header-menu-trigger").filter({ visible: true }).click();
        await page.getByTestId("workspace-vcs-view-publish").click();
        const panel = page.getByTestId("vcs-panel").filter({ visible: true });
        const selectHead = async (name: string) => {
          await panel.getByTestId("vcs-publish-head").getByRole("button").click();
          await page.getByRole("button", { name, exact: true }).click();
        };
        await panel.getByTestId("vcs-publish-remote").getByRole("button").click();
        await page.getByRole("button", { name: "origin", exact: true }).click();
        await selectHead("topic");
        await panel.getByTestId("vcs-publish-base").fill("main");
        await panel.getByTestId("vcs-find-request").click();
        const status = panel.getByTestId("vcs-publication-status");
        const refresh = () => status.getByRole("button", { name: "Refresh", exact: true }).click();
        const operation = panel.getByTestId("vcs-operation");
        const action = async (name: string, accept = true) => {
          page.once("dialog", (dialog) => (accept ? dialog.accept() : dialog.dismiss()));
          await status.getByRole("button", { name, exact: true }).click();
        };
        await expect(status).toContainText("Existing jj review");
        await expect(status).toContainText("Review checks · pending");
        const url =
          forge === "github"
            ? "https://github.com/paseo/vcs-ui/pull/7"
            : "https://gitlab.com/paseo/vcs-ui/-/merge_requests/7";
        await page.context().route(url, (route) => route.fulfill({ body: "Existing jj request" }));
        const opened = page.waitForEvent("popup");
        await panel.getByTestId("vcs-open-request").click();
        const popup = await opened;
        await expect(popup).toHaveURL(url);
        await popup.close();
        expect(await readFileIfPresent(pushes)).toBeNull();
        expect(await readFileIfPresent(path.join(repo.path, ".jj", "forge-creates"))).toBeNull();
        await selectHead("keep-local");
        await expect(status).toHaveCount(0);
        await selectHead("topic");
        await panel.getByTestId("vcs-find-request").click();
        await expect(status).toContainText("Review checks · pending");
        holdStatusReply = true;
        await refresh();
        await expect.poll(() => releaseStatusReply !== undefined).toBe(true);
        await selectHead("keep-local");
        releaseStatusReply!();
        await expect(status).toHaveCount(0);
        await expect(panel.getByTestId("vcs-open-request")).toHaveCount(0);
        await selectHead("topic");
        await panel.getByTestId("vcs-find-request").click();
        await expect(status).toContainText("Review checks · pending");
        await panel.getByTestId("vcs-publish-remote").getByRole("button").click();
        await page.getByRole("button", { name: "review", exact: true }).click();
        await expect(status).toHaveCount(0);
        await panel.getByTestId("vcs-publish-remote").getByRole("button").click();
        await page.getByRole("button", { name: "origin", exact: true }).click();
        await panel.getByTestId("vcs-find-request").click();
        await expect(status).toContainText("Review checks · pending");
        await patch({ failStatus: true });
        await refresh();
        await expect(status.getByRole("alert")).toContainText(
          "Forge status temporarily unavailable",
        );
        await expect(panel.getByTestId("vcs-open-request")).toHaveCount(0);
        await patch({ failStatus: false });
        await refresh();
        await expect(status).toContainText("Review checks · pending");
        // The cache is still fresh when transport returns; reconnect must invalidate it.
        await patch({ check: "failure" });
        disconnect!();
        await expect(status).toContainText("Review checks · failure", { timeout: 20_000 });
        await patch({ check: "pending", failAction: true });
        await refresh();
        await action("Enable auto-merge");
        await expect(operation).toContainText("Forge action temporarily unavailable");
        await patch({ failAction: false });
        await action("Enable auto-merge");
        await expect(operation).toContainText("Operation completed");
        await expect
          .poll(
            async () => (JSON.parse(await readFile(statePath, "utf8")) as { auto: boolean }).auto,
          )
          .toBe(true);
        await patch({ failAction: true });
        await action("Disable auto-merge");
        await expect(operation).toContainText("Forge action temporarily unavailable");
        await patch({ failAction: false });
        await action("Disable auto-merge");
        await expect(operation).toContainText("Operation completed");
        await expect
          .poll(
            async () => (JSON.parse(await readFile(statePath, "utf8")) as { auto: boolean }).auto,
          )
          .toBe(false);
        await patch({ check: "success" });
        await refresh();
        await expect(status).toContainText("Review checks · success");
        await status.getByRole("button", { name: "Merge method (squash)", exact: true }).click();
        await page.getByRole("button", { name: "rebase", exact: true }).click();
        const beforeCancel = await actions();
        await action("Merge", false);
        expect(await actions()).toEqual(beforeCancel);
        await patch({ number: 8 });
        await action("Merge");
        await expect(operation).toContainText("The selected change request changed");
        expect(await actions()).toEqual(beforeCancel);
        await patch({ number: 7, failAction: true });
        await refresh();
        await action("Merge");
        await expect(operation).toContainText("Forge action temporarily unavailable");
        await operation.scrollIntoViewIfNeeded();
        await page.screenshot({
          path: test.info().outputPath(`jj-${forge}-merge-error-${width}.png`),
        });
        await patch({ failAction: false, holdAction: true });
        dropReply = true;
        await action("Merge");
        await expect
          .poll(async () => (await actions()).filter((entry) => entry.action === "merge").length)
          .toBe(2);
        await expect(status.getByRole("button", { name: "Merge", exact: true })).toHaveCount(0);
        await expect(panel.getByTestId("vcs-find-request")).toBeDisabled();
        const requestsBeforeReconnect = executeRequests;
        disconnect!();
        await page.reload();
        await expect(operation).toContainText("Operation in progress", { timeout: 30_000 });
        await writeFile(path.join(repo.path, ".jj", "release-action"), "release\n");
        await expect(operation).toContainText("Operation completed", { timeout: 30_000 });
        await expect(status).toContainText("merged");
        await expect(status.getByRole("button", { name: "Merge", exact: true })).toHaveCount(0);
        expect(executeRequests).toBe(requestsBeforeReconnect);
        const calls = await actions();
        expect(calls.map((entry) => entry.action)).toEqual([
          "enable",
          "enable",
          "disable",
          "disable",
          "merge",
          "merge",
        ]);
        expect(calls.at(-1)?.args).toContain("--rebase");
        expect(await readFileIfPresent(pushes)).toBeNull();
        await status.scrollIntoViewIfNeeded();
        await page.screenshot({
          path: test.info().outputPath(`jj-${forge}-merged-reconnect-${width}.png`),
        });
        const actionLog = test.info().outputPath(`jj-${forge}-forge-actions-${width}.json`);
        await writeFile(actionLog, JSON.stringify(calls, null, 2));
        await test
          .info()
          .attach("forge-actions", { path: actionLog, contentType: "application/json" });
      },
    );
  }
}

for (const forge of ["github", "gitlab"]) {
  for (const width of [1400, 390]) {
    jjPublicationTest(
      `jj ${forge} auto-archives and restores a published owned copy at width ${width}`,
      async ({ page }) => {
        test.setTimeout(150_000);
        const { client, repo, remote, git, revision, created } =
          await createJjPublicationWorkspace(forge);
        const copy = await client.createWorkspace({
          source: { kind: "working-copy", projectId: created.workspace.projectId },
        });
        if (!copy.workspace) throw new Error(copy.error ?? "Missing owned workspace");
        const workspace = copy.workspace;
        const target = await client.requestVcs({
          type: "vcs.publication.resolve.request",
          workspaceId: workspace.id,
          providerId: "jj",
          selection: { remote: "origin", headRef: "topic", baseRef: "main" },
        });
        expect(target.headRevision).toBe(revision);
        await client.requestVcs({
          type: "vcs.publication.publish.request",
          workspaceId: workspace.id,
          providerId: "jj",
          target,
          operationId: "publish-owned-copy",
        });
        await expect
          .poll(() =>
            client.requestVcs({
              type: "vcs.operations.get.request",
              workspaceId: workspace.id,
              providerId: "jj",
              operationId: "publish-owned-copy",
            }),
          )
          .toMatchObject({ status: "succeeded" });
        expect(git("--git-dir", remote, "rev-parse", "refs/heads/topic")).toBe(revision);
        const statePath = path.join(workspace.workspaceDirectory, ".jj", "forge-state.json");
        await writeFile(statePath, JSON.stringify({ revision, check: "success" }));
        const previousConfig = await client.getDaemonConfig();
        await client.patchDaemonConfig({ autoArchiveAfterMerge: true });
        try {
          await page.setViewportSize({ width, height: 900 });
          await page.goto(buildHostWorkspaceRoute(getServerId(), workspace.id));
          await page.getByTestId("workspace-header-menu-trigger").filter({ visible: true }).click();
          await page.getByTestId("workspace-vcs-view-publish").click();
          const panel = page.getByTestId("vcs-panel").filter({ visible: true });
          await panel.getByTestId("vcs-publish-remote").getByRole("button").click();
          await page.getByRole("button", { name: "origin", exact: true }).click();
          await panel.getByTestId("vcs-publish-head").getByRole("button").click();
          await page.getByRole("button", { name: "topic", exact: true }).click();
          await panel.getByTestId("vcs-publish-base").fill("main");
          await panel.getByTestId("vcs-find-request").click();
          const status = panel.getByTestId("vcs-publication-status");
          await expect(status).toContainText("Existing jj review");
          await writeFile(statePath, JSON.stringify({ revision, check: "success", merged: true }));
          await status.getByRole("button", { name: "Refresh", exact: true }).click();
          await expect
            .poll(() => readFileIfPresent(path.join(workspace.workspaceDirectory, "published.txt")))
            .toBeNull();
          const recovery = page.getByTestId("workspace-recovery-action");
          await expect(recovery).toHaveText("Unarchive", { timeout: 30_000 });
          // The durable anchor exists before restoring through the normal workspace UI.
          const backend = execFileSync("jj", ["--ignore-working-copy", "git", "root"], {
            cwd: repo.path,
            encoding: "utf8",
          }).trim();
          expect(
            git("--git-dir", backend, "for-each-ref", "--format=%(refname)", "refs/paseo/recovery"),
          ).toMatch(/^refs\/paseo\/recovery\/[a-f0-9]{64}$/);
          await recovery.click();
          await expect(recovery).toHaveCount(0);
          expect(
            await readFile(path.join(workspace.workspaceDirectory, "published.txt"), "utf8"),
          ).toBe("selected revision\n");
          expect(
            git("--git-dir", backend, "for-each-ref", "--format=%(refname)", "refs/paseo/recovery"),
          ).toBe("");
          await page.screenshot({
            path: test.info().outputPath(`jj-${forge}-restored-copy-${width}.png`),
          });
        } finally {
          await client.patchDaemonConfig({
            autoArchiveAfterMerge: previousConfig.config.autoArchiveAfterMerge,
          });
        }
      },
    );
  }
}
