import type { ElectronApplication, Page } from "@playwright/test";
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

async function startSlowStreamingTurn(window: Page, prompt: string, responseText = `Mock 回复：「${prompt}」`) {
  const composer = window.locator(".composer .rich-input");
  await composer.fill(prompt);
  await expect(composer).toContainText(prompt);
  const sendButton = window.getByRole("button", { name: "发送", exact: true });
  await expect(sendButton).toBeEnabled();
  await sendButton.click();
  await expect(window.locator(".message-timeline"))
    .toContainText(responseText, { timeout: 10_000 });
}

async function returnToLiveEdge(window: Page) {
  const moveToLatest = window.getByRole("button", { name: "移动到最新", exact: true });
  if (await moveToLatest.isVisible().catch(() => false)) {
    await moveToLatest.click();
    await window.waitForTimeout(300);
  }
}

async function constrainTimelineViewport(app: ElectronApplication) {
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    if (!window) return;
    if (window.isMaximized()) window.unmaximize();
    window.setBounds({ width: 1000, height: 560 });
  });
}

async function scrollThenSwitchTab(
  window: Page,
  anchorText: string,
  desiredOffset: number,
  targetTabText: string,
) {
  await window.evaluate(({ targetText, requestedOffset, tabText }) => {
    const timeline = document.querySelector<HTMLElement>(".message-timeline");
    const anchor = Array.from(document.querySelectorAll<HTMLElement>("article.user-turn"))
      .find((element) => element.textContent?.includes(targetText));
    const targetTab = Array.from(document.querySelectorAll<HTMLElement>(".session-tab"))
      .find((element) => (
        element.getAttribute("aria-selected") === "false" &&
        element.textContent?.includes(tabText)
      ));
    if (!timeline || !anchor || !targetTab) throw new Error("immediate switch target is not mounted");
    const currentOffset = anchor.getBoundingClientRect().top - timeline.getBoundingClientRect().top;
    timeline.scrollTop += currentOffset - requestedOffset;
    timeline.dispatchEvent(new Event("scroll", { bubbles: true }));
    // Click in the same task: React commits the target session before the
    // rAF-based scroll sampler gets another opportunity to run.
    targetTab.click();
  }, { targetText: anchorText, requestedOffset: desiredOffset, tabText: targetTabText });
}

async function readAnchorOffset(window: Page, anchorText = ANCHOR_TEXT): Promise<number> {
  return window.evaluate((targetText) => {
    const timeline = document.querySelector<HTMLElement>(".message-timeline");
    const anchor = Array.from(document.querySelectorAll<HTMLElement>("article.user-turn"))
      .find((element) => element.textContent?.includes(targetText));
    if (!timeline || !anchor) throw new Error("scroll anchor is not mounted");
    return anchor.getBoundingClientRect().top - timeline.getBoundingClientRect().top;
  }, anchorText);
}

async function placeAnchorInViewport(
  window: Page,
  desiredOffset: number,
  anchorText = ANCHOR_TEXT,
): Promise<number> {
  await window.evaluate(({ targetText, desiredOffset: requestedOffset }) => {
    const timeline = document.querySelector<HTMLElement>(".message-timeline");
    const anchor = Array.from(document.querySelectorAll<HTMLElement>("article.user-turn"))
      .find((element) => element.textContent?.includes(targetText));
    if (!timeline || !anchor) throw new Error("scroll anchor is not mounted");
    const currentOffset = anchor.getBoundingClientRect().top - timeline.getBoundingClientRect().top;
    timeline.scrollTop += currentOffset - requestedOffset;
    timeline.dispatchEvent(new Event("scroll", { bubbles: true }));
  }, { targetText: anchorText, desiredOffset });
  await window.waitForTimeout(350);
  return readAnchorOffset(window, anchorText);
}

test("session switch restores a historical viewport after turn-window expansion", async ({ app, window }) => {
  test.setTimeout(180_000);
  await constrainTimelineViewport(app);
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

test("a streaming agent does not pull restored historical reading position to the bottom", async ({ app, window }) => {
  test.setTimeout(180_000);
  await constrainTimelineViewport(app);
  await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });

  await openChatSession(window);
  for (const prompt of SOURCE_TURNS) {
    await sendTurn(window, prompt);
  }

  const timeline = window.locator(".message-timeline");
  await window.getByRole("button", { name: "加载更多对话", exact: true }).click();
  const anchorRow = timeline.locator("article.user-turn", { hasText: ANCHOR_TEXT }).first();
  await expect(anchorRow).toBeVisible({ timeout: 10_000 });

  // The source Agent is now actively generating. Scrolling far enough away from
  // the live edge must escape follow mode before its growing output can race a
  // later session restoration.
  await startSlowStreamingTurn(window, "SLOW active-scroll-anchor");
  const beforeOffset = await placeAnchorInViewport(window, 96);
  expect(beforeOffset).toBeGreaterThanOrEqual(40);
  expect(beforeOffset).toBeLessThanOrEqual(150);

  await openChatSession(window);
  const sourceTab = window.locator('.session-tab[aria-selected="false"]').first();
  await expect(sourceTab).toBeVisible({ timeout: 10_000 });
  await sourceTab.click();
  await expect(anchorRow).toBeVisible({ timeout: 15_000 });

  const restoredOffset = await readAnchorOffset(window);
  expect(Math.abs(restoredOffset - beforeOffset)).toBeLessThanOrEqual(28);
  // Let more streamed content arrive after restoration. The reader remains
  // escaped from the live edge, so a growing final run cannot re-pin the view.
  await window.waitForTimeout(1200);
  const stableOffset = await readAnchorOffset(window);
  expect(Math.abs(stableOffset - beforeOffset)).toBeLessThanOrEqual(28);
});

test("a reader can escape the live edge with gradual wheel scrolling while an agent streams", async ({ app, window }) => {
  test.setTimeout(180_000);
  await constrainTimelineViewport(app);
  await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });

  await openChatSession(window);
  for (const prompt of SOURCE_TURNS) {
    await sendTurn(window, prompt);
  }
  // Previous settled-turn positioning may intentionally leave the viewport above
  // the tail. Return to the live edge so this test begins in the same locked
  // state as a reader who starts scrolling while output is arriving.
  await returnToLiveEdge(window);

  const timeline = window.locator(".message-timeline");
  await startSlowStreamingTurn(
    window,
    "SLOW MDEMO active-wheel-anchor",
    "以下是渲染元素巡检：",
  );
  const anchorRow = timeline.locator("article.user-turn", { hasText: ANCHOR_TEXT }).first();
  await timeline.hover();
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (await anchorRow.isVisible().catch(() => false)) break;
    // Trackpad-like deltas exercise the reader's real gradual path rather than
    // teleporting scrollTop directly to the historical target.
    await window.mouse.wheel(0, -20);
    await window.waitForTimeout(90);
  }
  await expect(anchorRow).toBeVisible({ timeout: 10_000 });

  const beforeOffset = await placeAnchorInViewport(window, 96);

  // This is the reported path: a running Agent is read through normal wheel
  // navigation, then the user switches to another session before returning
  // through the sidebar's asynchronous catalog-open path.
  await openChatSession(window);
  const sidebar = window.getByRole("complementary", { name: "搜索" });
  const sourceSidebarRow = sidebar.getByRole(
    "button",
    { name: "空闲 scroll-anchor-source-one", exact: true },
  ).first();
  await expect(sourceSidebarRow).toBeVisible({ timeout: 10_000 });
  await sourceSidebarRow.click();
  await expect(anchorRow).toBeVisible({ timeout: 15_000 });
  const restoredOffset = await readAnchorOffset(window);
  expect(Math.abs(restoredOffset - beforeOffset)).toBeLessThanOrEqual(28);

  await window.waitForTimeout(650);
  const afterGrowthOffset = await readAnchorOffset(window);
  expect(Math.abs(afterGrowthOffset - beforeOffset)).toBeLessThanOrEqual(28);
});

test("an immediate tab switch captures the latest historical scroll anchor", async ({ app, window }) => {
  test.setTimeout(180_000);
  await constrainTimelineViewport(app);
  await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });

  await openChatSession(window);
  for (const prompt of SOURCE_TURNS) {
    await sendTurn(window, prompt);
  }
  // Create the destination first, then return to A. The following scroll and
  // selection can therefore happen in one browser task rather than waiting for
  // draft creation to resolve.
  await openChatSession(window);
  const sourceTab = window.locator(".session-tab", { hasText: "scroll-anchor-source-one" }).first();
  await sourceTab.click();

  const timeline = window.locator(".message-timeline");
  await window.getByRole("button", { name: "加载更多对话", exact: true }).click();
  const anchorRow = timeline.locator("article.user-turn", { hasText: ANCHOR_TEXT }).first();
  await expect(anchorRow).toBeVisible({ timeout: 10_000 });

  await scrollThenSwitchTab(window, ANCHOR_TEXT, 96, "Chat agent");
  const chatTab = window.locator('.session-tab[aria-selected="true"]', { hasText: "Chat agent" });
  await expect(chatTab).toBeVisible({ timeout: 10_000 });
  await sourceTab.click();
  await expect(anchorRow).toBeVisible({ timeout: 15_000 });

  const restoredOffset = await readAnchorOffset(window);
  expect(Math.abs(restoredOffset - 96)).toBeLessThanOrEqual(28);
});
