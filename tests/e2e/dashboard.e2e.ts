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
  await expect(page.getByRole("heading", { name: "Build a dependency graph" })).toBeVisible();
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

test("inspector source button opens the highlighted code view", async ({ page }) => {
  await gotoDashboard(page);
  // symbols always carry a line range, so the highlight below is deterministic
  await page.getByRole("button", { name: "All types", exact: true }).click();
  await page.getByRole("menu").getByRole("menuitemradio", { name: "symbol", exact: true }).click();

  await page.locator(GRAPH_NODES).first().click();
  const inspector = page.locator(".inspector");
  await expect(inspector).toBeVisible();
  // selecting a node must never open the viewer on its own
  await expect(page.locator('[role="dialog"]')).toBeHidden();

  const label = (await inspector.locator(".source-path").textContent()) ?? "";
  expect(label).toMatch(/:\d+/); // "src/…/file.ts:8–14" — has a line range

  const src = inspector.locator(".code-open");
  await expect(src).toBeVisible();
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

  // explorer hides behind an icon-only peek and reopens the same way
  await page.getByLabel("Hide explorer").click();
  await expect(page.locator("aside.explorer")).toHaveCount(0);
  await page.getByLabel("Show explorer").click();
  await expect(page.locator("aside.explorer")).toBeVisible();

  // details collapses to an icon-only peek
  await page.getByLabel("Hide details").click();
  await expect(page.locator(".inspector")).toHaveCount(0);
  await page.getByLabel("Show details").click();
  await expect(page.locator(".inspector")).toBeVisible();

  // relationship navigation keeps a back/forward trail
  await page.locator(".edge-target").first().click();
  await expect(page.getByLabel("Previous node")).toBeEnabled();
  await page.getByLabel("Previous node").click();
  await expect(page.getByLabel("Next node")).toBeEnabled();
});

test("brand click resets the dashboard", async ({ page }) => {
  await gotoDashboard(page);
  await page.locator(GRAPH_NODES).first().click();
  await expect(page.locator(".inspector")).toBeVisible();
  await page.getByLabel("Search nodes").fill("users");
  await page.getByRole("button", { name: "All types", exact: true }).click();
  await page.getByRole("menu").getByRole("menuitemradio", { name: "symbol", exact: true }).click();

  await page.getByRole("button", { name: "Reset dashboard" }).click();
  // reset clears the dashboard back to the index screen, keeping a history
  await expect(page.getByRole("heading", { name: "Build a dependency graph" })).toBeVisible();
  const history = page.locator(".repo-history");
  await expect(history).toBeVisible();
  await expect(history.locator("li")).not.toHaveCount(0);

  // a history entry restores that repository
  await history.locator("li .link").first().click();
  await expect(page.locator(GRAPH_NODES).first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByLabel("Search nodes")).toHaveValue("");
});

test("snapshot round-trips through the API and the index screen", async ({ page }) => {
  await gotoDashboard(page);
  await expect(page.getByRole("button", { name: "Download snapshot" })).toBeVisible();

  const repos = await (await page.request.get("/api/repositories")).json();
  const id = repos.repositories[0].id;
  const snapshot = await (await page.request.get(`/api/repositories/${id}/snapshot`)).json();
  expect(snapshot.format).toBe("relic-snapshot");
  expect(snapshot.nodes.length).toBeGreaterThan(0);
  expect(snapshot.edges.length).toBeGreaterThan(0);

  await page.getByRole("button", { name: "Reset dashboard" }).click();
  await expect(page.getByRole("heading", { name: "Build a dependency graph" })).toBeVisible();
  await page.locator('input[type="file"]').setInputFiles({
    name: "snapshot.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(snapshot)),
  });
  await expect(page.locator(GRAPH_NODES).first()).toBeVisible({ timeout: 30_000 });
});

test("indexed repository can be deleted from the cache", async ({ page }) => {
  await gotoDashboard(page);
  await page.getByRole("button", { name: "Reset dashboard" }).click();
  await expect(page.locator(".repo-history")).toBeVisible();

  await page
    .getByLabel(/Delete .* index/)
    .first()
    .click();
  await expect(page.locator(".repo-history")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Build a dependency graph" })).toBeVisible();
});

test("static deployment renders snapshots client-side without the API", async ({ page }) => {
  await page.route("**/api/repositories", (route) => route.fulfill({ status: 404, body: "" }));
  await page.goto("/");
  await expect(page.locator(".static-note")).toBeVisible();
  await expect(page.getByLabel("Repository source")).toHaveCount(0);
  await expect(page.getByLabel("Re-index repository")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Load snapshot" })).toBeVisible();

  const snapshot = {
    format: "relic-snapshot",
    version: 1,
    repository: {
      name: "demo",
      rootPath: "/demo",
      lastRevision: null,
      indexedAt: null,
      durationMs: null,
      fileCount: 1,
      diagnostics: [],
    },
    nodes: [
      {
        id: "a",
        type: "file",
        name: "src/a.ts",
        qualifiedName: null,
        filePath: "src/a.ts",
        startLine: null,
        endLine: null,
      },
      {
        id: "b",
        type: "symbol",
        name: "foo",
        qualifiedName: "foo",
        filePath: "src/a.ts",
        startLine: 1,
        endLine: 2,
        metadata: { kind: "function" },
      },
    ],
    edges: [
      {
        id: "e1",
        sourceId: "a",
        targetId: "b",
        type: "DECLARES",
        confidence: 1,
        evidence: { source: "static", file: "src/a.ts", line: 1 },
      },
    ],
  };
  await page.locator('input[type="file"]').setInputFiles({
    name: "snapshot.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(snapshot)),
  });
  await expect(page.locator(GRAPH_NODES).first()).toBeVisible();
  await page.locator(GRAPH_NODES).first().click();
  await expect(page.locator(".inspector")).toBeVisible();
  await expect(page.locator(".edge-item")).toHaveCount(1);
  // no file viewer without the API
  await expect(page.locator(".code-open")).toHaveCount(0);
});

test("theme toggle flips the data-theme attribute", async ({ page }) => {
  await page.goto("/");
  const html = page.locator("html");
  const before = (await html.getAttribute("data-theme")) ?? "dark";
  await page.getByLabel("Toggle theme").click();
  await expect(html).toHaveAttribute("data-theme", before === "dark" ? "light" : "dark");
});
