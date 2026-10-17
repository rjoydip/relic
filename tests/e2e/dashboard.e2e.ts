import { expect, test, type Page } from "@playwright/test";
import { resolve } from "node:path";

const FIXTURE = resolve("tests/fixtures/starter-hono");
const GRAPH_NODES = ".react-flow__node";

// Serial: the first test indexes the fixture the rest of the suite exercises
// (fresh API db per run, see playwright.config.ts).
test.describe.configure({ mode: "serial" });

async function gotoDashboard(page: Page) {
  await page.goto("/");
  await expect(page.locator(GRAPH_NODES).first()).toBeVisible({ timeout: 30_000 });
}

test("indexes a repository from the empty state", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Index a repository" })).toBeVisible();
  await page.getByLabel("Repository source").fill(FIXTURE);
  await page.getByLabel("Index repository").click();
  await expect(page.locator(GRAPH_NODES).first()).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(".brand")).toBeVisible();
  await expect(page.locator(".inspector")).toHaveCount(0);
});

test("opens at a readable zoom anchored to the graph top", async ({ page }) => {
  await gotoDashboard(page);
  const styleAttr = (await page.locator(".react-flow__viewport").getAttribute("style")) ?? "";
  const scale = Number(/scale\(([\d.]+)\)/.exec(styleAttr)?.[1]);
  // contract: never unreadably small, never over-zoomed (0.55–0.9)
  expect(scale).toBeGreaterThanOrEqual(0.55);
  expect(scale).toBeLessThanOrEqual(0.9);
  // top-anchored: the graph starts near the canvas top instead of being
  // vertically centred the way fitView would leave it
  let minTop = Number.POSITIVE_INFINITY;
  const nodeCount = await page.locator(GRAPH_NODES).count();
  for (let i = 0; i < nodeCount; i++) {
    const box = await page.locator(GRAPH_NODES).nth(i).boundingBox();
    if (box) minTop = Math.min(minTop, box.y);
  }
  expect(minTop).toBeGreaterThan(0);
  expect(minTop).toBeLessThan(120);
});

test("type filter is a dropdown that narrows the graph", async ({ page }) => {
  await gotoDashboard(page);
  const before = await page.locator(GRAPH_NODES).count();

  await page.getByRole("button", { name: "All types", exact: true }).click();
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  await menu.getByRole("menuitemradio", { name: "file", exact: true }).click();
  await expect(menu).toBeHidden();

  const toolbar = page.locator(".explorer-toolbar");
  await expect(toolbar.getByRole("button", { name: "file", exact: true })).toBeVisible();
  const after = await page.locator(GRAPH_NODES).count();
  expect(after).toBeGreaterThan(0);
  expect(after).toBeLessThan(before);
});

test("inspector source link opens the highlighted code view", async ({ page }) => {
  await gotoDashboard(page);
  // symbols always carry a line range, so the highlight below is deterministic
  await page.getByRole("button", { name: "All types", exact: true }).click();
  await page.getByRole("menu").getByRole("menuitemradio", { name: "symbol", exact: true }).click();

  await page.locator(GRAPH_NODES).first().click();
  const inspector = page.locator(".inspector");
  await expect(inspector).toBeVisible();
  const src = inspector.locator('button[title="Show file content"]');
  await expect(src).toBeVisible();
  const label = (await src.textContent()) ?? "";
  expect(label).toMatch(/:\d+/); // "src/…/file.ts:8–14" — has a line range

  await src.click();
  const dialog = page.locator('[role="dialog"]');
  await expect(dialog).toBeVisible();
  const file = label.split(":")[0]?.split(/[\\/]/).at(-1);
  await expect(dialog).toContainText(file!);
  await expect(dialog.locator('[data-slot="code-block-content"]')).toBeVisible();
  await expect(
    dialog.locator('[data-slot="code-block-line"][data-variant="highlighted"]').first(),
  ).toBeVisible();

  const copy = dialog.locator('[data-slot="code-block-copy-button"]');
  await copy.click();
  await expect(copy).toHaveAttribute("aria-label", "Copied");

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});

test("theme toggle flips the data-theme attribute", async ({ page }) => {
  await page.goto("/");
  const html = page.locator("html");
  const before = (await html.getAttribute("data-theme")) ?? "dark";
  await page.getByLabel("Toggle theme").click();
  await expect(html).toHaveAttribute("data-theme", before === "dark" ? "light" : "dark");
});
