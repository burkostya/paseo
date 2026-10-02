import { expect, test } from "../support/fixtures";
import type { Page } from "@playwright/test";
import {
  allowPermission,
  denyPermission,
  waitForPermissionPrompt,
} from "../support/helpers/permissions";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";
import { submitMessage } from "../support/helpers/composer";

const EXPECTED_PLAN_MARKDOWN = [
  "1. Add the (c) README note.",
  '2. Run --name="my repo".',
  "3. Verify ---buzz in the diff.",
].join("\n");
const FOLLOW_UP_PROMPT = "Continue with the approved work.";

async function expectSingleApprovedPlan(page: Page): Promise<void> {
  const card = page.getByTestId("timeline-plan-card");
  await expect(card).toHaveCount(1, { timeout: 30_000 });
  await expect(card.getByTestId("permission-plan-resolution")).toHaveText("Approved");
  await expect(page.getByTestId("permission-plan-card")).toHaveCount(0);
  await expect(page.getByTestId("permission-request-accept")).toHaveCount(0);
  await expect(page.getByTestId("permission-request-deny")).toHaveCount(0);
}

async function expectPlanBeforeFollowUp(page: Page): Promise<void> {
  const followUp = page.getByText(FOLLOW_UP_PROMPT, { exact: true });
  await expect(followUp).toBeVisible();
  const followUpElement = await followUp.elementHandle();
  if (!followUpElement) throw new Error("Expected the follow-up message to be rendered");
  expect(
    await page
      .getByTestId("timeline-plan-card")
      .evaluate(
        (element, following) =>
          Boolean(element.compareDocumentPosition(following) & Node.DOCUMENT_POSITION_FOLLOWING),
        followUpElement,
      ),
  ).toBe(true);
}

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

      await expectSingleApprovedPlan(page);
      const timelinePlan = page.getByTestId("timeline-plan-card");

      const timelineCopyButton = timelinePlan.getByTestId("plan-copy-button");
      await timelineCopyButton.click();
      await expect(timelineCopyButton).toHaveAccessibleName("Copied");
      await expect
        .poll(() => page.evaluate<string>("navigator.clipboard.readText()"))
        .toBe(EXPECTED_PLAN_MARKDOWN);

      await submitMessage(page, FOLLOW_UP_PROMPT);
      await expectPlanBeforeFollowUp(page);

      await page.reload();
      await expectSingleApprovedPlan(page);
      await expectPlanBeforeFollowUp(page);
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

      await page.reload();
      await expect(page.getByTestId("timeline-plan-card")).toHaveCount(1, { timeout: 30_000 });
      await expect(page.getByTestId("permission-plan-resolution")).toContainText("Rejected");
      await expect(page.getByTestId("permission-plan-card")).toHaveCount(0);
    } finally {
      await session.cleanup();
    }
  });
});
