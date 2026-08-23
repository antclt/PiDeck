import type { Page } from "@playwright/test";
import { test, expect } from "./mock-pi-fixture";

const SOURCE_TURNS = [
  "scroll-anchor-source-one",
  "scroll-anchor-source-two",
  "scroll-anchor-source-three",
  "scroll-anchor-source-four",
  "scroll-anchor-source-five",
];
const ANCHOR_TEXT = SOURCE_TURNS[1];

async function openChatSession(window: Page) {
  const newSession = window.getByRole("button", { name: "新会话", exact: true });
  await expect(newSession).toBeVisible({ timeout: 15_000 });
  await newSession.click();
  const composer = window.locator(".composer .rich-input");
  await expect(composer).toHaveAttribute("contenteditable", "true", { timeout: 30_000 });
  return composer;
}

async function approveProjectTrustIfRequested(window: Page) {
  const trust = window.getByRole("button", { name: "本次信任", exact: true });
  if (await trust.isVisible().catch(() => false)) {
    await trust.click();
  }
}

async function sendTurn(window: Page, prompt: string) {
  const composer = window.locator(".composer .rich-input");
  await composer.fill(prompt);
  await expect(composer).toContainText(prompt);
  // Draft activation can surface the project trust gate after the composer is
  // already interactive. Resolve it before targeting the underlying send button.
  await window.waitForTimeout(250);
  await approveProjectTrustIfRequested(window);
  const sendButton = window.getByRole("button", { name: "发送", exact: true });
  await expect(sendButton).toBeEnabled();
  await sendButton.click();
  await expect(window.locator(".message-timeline"))
    .toContainText(`Mock 回复：「${prompt}」流式渲染验证完成`, { timeout: 20_000 });
}

async function readAnchorOffset(window: Page): Promise<number> {
  return window.evaluate((anchorText) => {
    const timeline = document.querySelector<HTMLElement>(".message-timeline");
    const anchor = Array.from(document.querySelectorAll<HTMLElement>("article.user-turn"))
      .find((element) => element.textContent?.includes(anchorText));
    if (!timeline || !anchor) throw new Error("scroll anchor is not mounted");
    return anchor.getBoundingClientRect().top - timeline.getBoundingClientRect().top;
  }, ANCHOR_TEXT);
}

async function placeAnchorInViewport(window: Page, desiredOffset: number): Promise<number> {
  await window.evaluate(({ anchorText, desiredOffset: requestedOffset }) => {
    const timeline = document.querySelector<HTMLElement>(".message-timeline");
    const anchor = Array.from(document.querySelectorAll<HTMLElement>("article.user-turn"))
      .find((element) => element.textContent?.includes(anchorText));
    if (!timeline || !anchor) throw new Error("scroll anchor is not mounted");
    const currentOffset = anchor.getBoundingClientRect().top - timeline.getBoundingClientRect().top;
    timeline.scrollTop += currentOffset - requestedOffset;
    timeline.dispatchEvent(new Event("scroll", { bubbles: true }));
  }, { anchorText: ANCHOR_TEXT, desiredOffset });
  await window.waitForTimeout(350);
  return readAnchorOffset(window);
}

test("session switch restores a historical viewport after turn-window expansion", async ({ app, window }) => {
  test.setTimeout(180_000);
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setBounds({ width: 1000, height: 560 });
  });
  await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });

  const sourceComposer = await openChatSession(window);
  await expect(sourceComposer).toHaveAttribute("contenteditable", "true");
  for (const prompt of SOURCE_TURNS) {
    await sendTurn(window, prompt);
  }

  const timeline = window.locator(".message-timeline");
  // Five completed runs exceed the 3-turn tail window. Use the same explicit
  // "load more" control a reader can invoke to materialize the older cohort.
  const loadMore = window.getByRole("button", { name: "加载更多对话", exact: true });
  await expect(loadMore).toBeVisible({ timeout: 10_000 });
  await loadMore.click();
  const anchorRow = timeline.locator("article.user-turn", { hasText: ANCHOR_TEXT }).first();
  await expect(anchorRow).toBeVisible({ timeout: 10_000 });

  const beforeOffset = await placeAnchorInViewport(window, 96);
  expect(beforeOffset).toBeGreaterThanOrEqual(40);
  expect(beforeOffset).toBeLessThanOrEqual(150);

  // A new empty Chat session switches the solo pane without creating a second
  // mock runtime. Selecting A again exercises the same session restoration path
  // used by sidebar and tab selection.
  await openChatSession(window);
  const sourceTab = window.locator('.session-tab[aria-selected="false"]').first();
  await expect(sourceTab).toBeVisible({ timeout: 10_000 });
  await sourceTab.click();
  await expect(anchorRow).toBeVisible({ timeout: 15_000 });

  const afterOffset = await readAnchorOffset(window);
  expect(Math.abs(afterOffset - beforeOffset)).toBeLessThanOrEqual(28);
});
