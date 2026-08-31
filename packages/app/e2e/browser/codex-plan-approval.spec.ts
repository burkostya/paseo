import { expect, test } from "../support/fixtures";
import {
  allowPermission,
  denyPermission,
  waitForPermissionPrompt,
} from "../support/helpers/permissions";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";

const EXPECTED_PLAN_MARKDOWN = [
  "1. Add the README note.",
  "2. Keep the change scoped.",
  "3. Verify the diff.",
].join("\n");

test.describe("Codex plan approval", () => {
  test("shows a single actionable plan panel, copies its Markdown, and keeps resolved plan history", async ({
    context,
    page,
  }) => {
    test.setTimeout(180_000);
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);

    const session = await seedMockAgentWorkspace({
      repoPrefix: "codex-plan-approval-",
      title: "Codex plan approval e2e",
      initialPrompt: "Emit synthetic plan approval.",
    });

    try {
      await openAgentRoute(page, session);

      await waitForPermissionPrompt(page, 120_000);

      const pendingPlan = page.getByTestId("permission-plan-card");
      await expect(pendingPlan).toHaveCount(1);
      await expect(page.getByTestId("timeline-plan-card")).toHaveCount(0);

      const pendingCopyButton = pendingPlan.getByTestId("plan-copy-button");
      await pendingCopyButton.click();
      await expect(pendingCopyButton).toHaveAccessibleName("Copied");
      await expect
        .poll(() => page.evaluate<string>("navigator.clipboard.readText()"))
        .toBe(EXPECTED_PLAN_MARKDOWN);

      await allowPermission(page);

      await expect(page.getByTestId("permission-plan-card")).toHaveCount(0, {
        timeout: 30_000,
      });
      const timelinePlan = page.getByTestId("timeline-plan-card");
      await expect(timelinePlan).toHaveCount(1, { timeout: 30_000 });
      await expect(page.getByTestId("permission-plan-resolution")).toContainText("Approved");

      const timelineCopyButton = timelinePlan.getByTestId("plan-copy-button");
      await timelineCopyButton.click();
      await expect(timelineCopyButton).toHaveAccessibleName("Copied");
      await expect
        .poll(() => page.evaluate<string>("navigator.clipboard.readText()"))
        .toBe(EXPECTED_PLAN_MARKDOWN);
    } finally {
      await session.cleanup();
    }
  });

  test("labels an explicitly denied plan as Rejected", async ({ page }) => {
    test.setTimeout(180_000);
    const session = await seedMockAgentWorkspace({
      repoPrefix: "codex-plan-rejection-",
      title: "Codex plan rejection e2e",
      initialPrompt: "Emit synthetic plan approval.",
    });

    try {
      await openAgentRoute(page, session);
      await waitForPermissionPrompt(page, 120_000);
      await denyPermission(page);

      await expect(page.getByTestId("permission-plan-card")).toHaveCount(0, {
        timeout: 30_000,
      });
      await expect(page.getByTestId("timeline-plan-card")).toHaveCount(1, {
        timeout: 30_000,
      });
      await expect(page.getByTestId("permission-plan-resolution")).toContainText("Rejected");
    } finally {
      await session.cleanup();
    }
  });
});
