import { describe, expect, test } from "bun:test";
import { loadHighlighter } from "../../../apps/dashboard/src/lib/highlighter";

const SOURCE = [
  "import { greet } from './greet';",
  "",
  "/* a block comment",
  "   spanning several lines",
  "   with the test seam inside */",
  "export function main(): string {",
  "  const msg = `hello ${1 + 1}`;",
  "  return msg;",
  "}",
].join("\n");

interface Tok {
  type: unknown;
  props: { children: string; style: Record<string, string | undefined> };
}

// Merges adjacent same-style tokens so chunk boundaries that split a token
// differently than a one-shot highlight still compare equal.
function normalize(lines: Tok[][]) {
  return lines.map((line) => {
    const merged: Array<{ text: string; style: Record<string, string | undefined> }> = [];
    for (const tok of line) {
      const last = merged.at(-1);
      if (last && JSON.stringify(last.style) === JSON.stringify(tok.props.style)) {
        last.text += tok.props.children;
      } else {
        merged.push({ text: tok.props.children, style: tok.props.style });
      }
    }
    return merged;
  });
}

describe("dashboard highlighter", () => {
  test("highlights every line with content matching the source", async () => {
    const h = await loadHighlighter("typescript");
    expect(h).not.toBeNull();
    const sourceLines = SOURCE.split("\n");
    const { lines } = h!.highlight(SOURCE) as unknown as { lines: Tok[][] };
    expect(lines).toHaveLength(sourceLines.length);
    lines.forEach((line, i) => {
      expect(line.map((t) => t.props.children).join("")).toBe(sourceLines[i]!);
      expect(line.every((t) => t.type === "span")).toBe(true);
    });
  });

  test("continuing with grammar state matches a one-shot highlight", async () => {
    const h = await loadHighlighter("ts"); // alias path
    expect(h).not.toBeNull();
    if (!h) return;
    const sourceLines = SOURCE.split("\n");
    // seam sits INSIDE the block comment — continuation must know it is
    // still in comment context to color the tail lines the same way
    const seam = 4;
    const first = h.highlight(sourceLines.slice(0, seam).join("\n"));
    const rest = h.highlight(sourceLines.slice(seam).join("\n"), first.state);
    const oneShot = h.highlight(SOURCE);

    const streamed = normalize([
      ...(first.lines as unknown as Tok[][]),
      ...(rest.lines as unknown as Tok[][]),
    ]);
    expect(streamed).toEqual(normalize(oneShot.lines as unknown as Tok[][]));
  });

  test("unknown languages resolve to null", async () => {
    expect(await loadHighlighter("not-a-language")).toBeNull();
  });

  // every lazy-loaded grammar loader must run at least once — bun enforces
  // coverage thresholds per file, and these loaders are most of the file
  test("loads every bundled language", async () => {
    const languages = [
      "bash",
      "css",
      "diff",
      "html",
      "javascript",
      "json",
      "jsx",
      "markdown",
      "python",
      "sql",
      "tsx",
      "typescript",
      "yaml",
    ];
    for (const lang of languages) {
      expect(await loadHighlighter(lang)).not.toBeNull();
    }
  });
});
