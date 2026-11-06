import { expect, test, type Page } from "@playwright/test";
import { resolve } from "node:path";

const FIXTURE = resolve("tests/fixtures/analyzer/typescript/starter-hono");
const GRAPH_NODES = ".react-flow__node";

// Serial: the first test indexes the fixture the rest of the suite exercises
// (fresh API db per run, see playwright.config.ts).
test.describe.configure({ mode: "serial" });

async function gotoDashboard(page: Page) {
  await page.goto("/");
  await expect(page.locator(GRAPH_NODES).first()).toBeVisible({ timeout: 30_000 });
}

async function clickNode(page: Page, label: string) {
  const node = page.locator(GRAPH_NODES).filter({ hasText: label }).first();
  await expect(node).toBeVisible();
  await node.click();
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
  let minLeft = Number.POSITIVE_INFINITY;
  // OnlyRenderVisibleElements means the DOM contains a subset of the graph;
  // snapshot the rendered handles instead of waiting on index-based locators.
  const handles = await page.locator(GRAPH_NODES).elementHandles();
  for (const handle of handles) {
    const box = await handle.boundingBox();
    if (!box) continue;
    minTop = Math.min(minTop, box.y);
    minLeft = Math.min(minLeft, box.x);
  }
  expect(minTop).toBeGreaterThan(0);
  expect(minTop).toBeLessThan(120);
  // a wide graph must not start off-screen to the left
  expect(minLeft).toBeGreaterThan(0);
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

test("side panel switches between files and details without resizing the canvas", async ({
  page,
}) => {
  await gotoDashboard(page);
  await page.locator(GRAPH_NODES).first().click();
  const canvas = page.locator("section.canvas");
  const inspector = page.locator(".inspector");
  await expect(inspector).toBeVisible();

  const canvasWidth = (await canvas.boundingBox())!.width;
  const inspectorWidth = (await inspector.boundingBox())!.width;
  expect(inspectorWidth).toBeGreaterThanOrEqual(420);
  expect(canvasWidth).toBeGreaterThan(inspectorWidth);

  // Files and Details share the same column; switching must not resize the graph
  await page.getByLabel("Show files").click();
  await expect(page.locator(".inspector")).toHaveCount(0);
  const explorer = page.locator("aside.explorer");
  await expect(explorer).toBeVisible();
  const explorerWidth = (await explorer.boundingBox())!.width;
  expect(Math.abs(explorerWidth - inspectorWidth)).toBeLessThan(2);
  expect(Math.abs((await canvas.boundingBox())!.width - canvasWidth)).toBeLessThan(2);

  await page.getByLabel("Show details").click();
  await expect(page.locator(".inspector")).toBeVisible();
  expect(Math.abs((await canvas.boundingBox())!.width - canvasWidth)).toBeLessThan(2);

  // hiding the whole side panel lets the graph take the full width
  await page.getByLabel("Hide panel").click();
  await expect(page.locator(".inspector")).toHaveCount(0);
  await expect(page.locator("aside.explorer")).toHaveCount(0);
  const fullWidth = (await canvas.boundingBox())!.width;
  expect(fullWidth).toBeGreaterThan(canvasWidth + 100);
  await expect(page.getByLabel("Show side panel")).toBeVisible();
  // clicking a node reopens the panel instead of leaving it hidden
  await page.locator(GRAPH_NODES).first().click();
  await expect(page.locator(".inspector")).toBeVisible();
  expect(Math.abs((await canvas.boundingBox())!.width - canvasWidth)).toBeLessThan(2);
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

  // same side panel: Details switches to Files and back
  await page.getByLabel("Show files").click();
  await expect(page.locator(".inspector")).toHaveCount(0);
  await expect(page.locator("aside.explorer")).toBeVisible();
  await page.getByLabel("Show details").click();
  await expect(page.locator(".inspector")).toBeVisible();

  // relationship navigation keeps a back/forward trail
  await inspector.getByRole("tab", { name: /^Relationships/ }).click();
  await inspector.locator(".relationship-item .link").first().click();
  await expect(page.getByLabel("Previous node")).toBeEnabled();
  await page.getByLabel("Previous node").click();
  await expect(page.getByLabel("Next node")).toBeEnabled();
});

test("inspector shows impact, relationships, and tests as tables", async ({ page }) => {
  await gotoDashboard(page);
  await page.getByLabel("Search nodes").fill("UserService.updateUser");
  await clickNode(page, "UserService.updateUser");

  const inspector = page.locator(".inspector");
  await expect(inspector.getByRole("tab", { name: /^Impact/ })).toBeVisible();
  await expect(inspector.locator("table.inspector-table")).toBeVisible();
  await expect(inspector.locator(".impact-item").first()).toBeVisible();
  await expect(inspector.locator(".impact-item .cell-conf").first()).toContainText("%");
  await expect(inspector.locator(".impact-item .edge-file").first()).toBeVisible();

  // the "tests" toggle changes the visible rows
  const items = inspector.locator(".impact-item");
  const before = await items.count();
  await inspector.getByLabel("tests").uncheck();
  await expect(items).not.toHaveCount(before);

  // risk score is explainable: tooltip factors + files that drive it
  await inspector.locator(".risk-score").hover();
  await expect(page.locator(".cn-tooltip-content")).toContainText("affected");
  await expect(inspector.locator(".risk-drivers")).toContainText("Risk-related files");

  // downstream rows are opt-in and come from the indirect toggle
  await expect(inspector.locator(".inspector-hint")).toContainText("indirect");
  await inspector.getByLabel("indirect").check();
  await expect(inspector.locator(".dir-pill.dir-downstream").first()).toBeVisible();

  // Relationships and Tests are tabbed tables, not collapsible lists
  await inspector.getByRole("tab", { name: /^Relationships/ }).click();
  await expect(inspector.locator("table.inspector-table")).toBeVisible();
  await expect(inspector.locator(".relationship-item").first()).toBeVisible();

  await inspector.getByRole("tab", { name: /^Tests/ }).click();
  await expect(inspector.locator("table.inspector-table")).toBeVisible();
  await expect(inspector.locator(".test-item").first()).toBeVisible();
});

test("inspector shows owners, coupling, risk, and highlights a cycle", async ({ page }) => {
  await gotoDashboard(page);
  await page.getByLabel("Search nodes").fill("cycleA");
  await clickNode(page, "cycleA");

  const inspector = page.locator(".inspector");
  await expect(inspector.getByText("Coupling")).toBeVisible();
  await expect(inspector.locator(".owners-row")).toContainText("@relic/core");
  await expect(inspector.locator(".risk-score")).toContainText("risk");

  await inspector.getByRole("tab", { name: /^Cycles/ }).click();
  await expect(inspector.locator("table.inspector-table")).toBeVisible();
  const cycle = inspector.locator(".cycle-item");
  await expect(cycle).toHaveCount(1);
  await cycle.getByRole("button", { name: "Highlight" }).click();
  await expect(inspector.getByRole("button", { name: "Clear highlight" })).toBeVisible();
  // Only visible cards are in the DOM; the selected cycle member must be marked.
  await expect.poll(() => page.locator(`${GRAPH_NODES}.cycle`).count()).toBeGreaterThan(0);
});

test("metadata button opens the index summary", async ({ page }) => {
  await gotoDashboard(page);
  await page.getByRole("button", { name: /metadata/i }).click();

  const dialog = page.locator('[role="dialog"]');
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("Metadata");
  await expect(dialog).toContainText("Files");
  await expect(dialog).toContainText("Nodes");
  await expect(dialog).toContainText("Edges");
  await expect(dialog).toContainText("Diagnostics");
  await expect(dialog.locator(".metadata-item-icon")).toHaveCount(8);
  await expect(dialog).toContainText(/No diagnostics were recorded|unresolved|parse error/i);

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});

test("brand click resets the dashboard", async ({ page }) => {
  await gotoDashboard(page);
  await page.locator(GRAPH_NODES).first().click();
  await expect(page.locator(".inspector")).toBeVisible();
  await page.getByLabel("Show files").click();
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
  await page.getByRole("tab", { name: /^Relationships/ }).click();
  await expect(page.locator(".relationship-item")).toHaveCount(1);
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
