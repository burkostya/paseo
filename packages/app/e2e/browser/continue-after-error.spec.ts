import { expect, test } from "../support/fixtures";
import {
  attachImageFromMenu,
  expectAttachmentPill,
  expectComposerDraft,
  expectComposerVisible,
  fillComposerDraft,
} from "../support/helpers/composer";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";

const SYNTHETIC_FAILURE_PROMPT = "Emit a synthetic turn failure.";
const IMAGE = {
  name: "continue-after-error.png",
  mimeType: "image/png",
  buffer: Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgJWR9awAAAABJRU5ErkJggg==",
    "base64",
  ),
};

test("Continue replaces the empty primary send action after an agent error", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  const agent = await seedMockAgentWorkspace({
    repoPrefix: "continue-after-error-",
    title: "Continue after error",
    model: "e2e-fast-stream",
  });

  try {
    await agent.client.sendAgentMessage(agent.agentId, SYNTHETIC_FAILURE_PROMPT);
    const failedTurn = await agent.client.waitForFinish(agent.agentId, 30_000);
    expect(failedTurn.final?.lastError).toBe("Requested mock provider failure");

    await page.setViewportSize({ width: 390, height: 844 });
    await openAgentRoute(page, agent);
    await expectComposerVisible(page);

    const continueButton = page.getByTestId("agent-continue-after-error");
    await expect(continueButton).toBeVisible();
    await expect(continueButton).toBeEnabled();
    await expect(continueButton).toContainText("Continue");
    await page.screenshot({
      path: testInfo.outputPath("continue-after-error-compact.png"),
      fullPage: true,
    });

    await attachImageFromMenu(page, IMAGE);
    await expectAttachmentPill(page, "composer-image-attachment-pill");
    await expect(continueButton).toBeVisible();

    await fillComposerDraft(page, "Keep this draft");
    await expect(continueButton).toBeHidden();
    await expect(page.getByRole("button", { name: "Send message" })).toBeVisible();
    await fillComposerDraft(page, "");
    await expect(continueButton).toBeVisible();
    await continueButton.click();
    await expectComposerDraft(page, "");
    await expectAttachmentPill(page, "composer-image-attachment-pill");
    await expect(continueButton).toBeHidden();
    const continueMessage = page.getByTestId("user-message").filter({ hasText: "Continue" });
    await expect(continueMessage).toHaveCount(1);
    await expect(
      continueMessage.getByRole("button", { name: "Open image attachment" }),
    ).toHaveCount(0);
    await agent.client.waitForFinish(agent.agentId, 30_000);

    await agent.client.sendAgentMessage(agent.agentId, SYNTHETIC_FAILURE_PROMPT);
    const nextFailedTurn = await agent.client.waitForFinish(agent.agentId, 30_000);
    expect(nextFailedTurn.final?.lastError).toBe("Requested mock provider failure");
    await expect(continueButton).toBeVisible();

    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(continueButton).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath("continue-after-error-wide.png"),
      fullPage: true,
    });
  } finally {
    await agent.cleanup();
  }
});
