import { useEffect, useRef, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  CodeBlock,
  CodeBlockContent,
  CodeBlockCopyButton,
  CodeBlockLine,
} from "@/components/ui/code-block";
import { useHighlightedCode } from "@/hooks/use-highlighted-code";
import { api } from "./api";

export interface CodeTarget {
  path: string;
  startLine: number | null;
  endLine: number | null;
}

interface CodeModalProps {
  repoId: string;
  code: CodeTarget;
  onClose: () => void;
}

// shiki grammar id per extension; the highlighter's own alias map handles
// the rest (ts, js, md, yml, sh) and renders unknown extensions as plain text
const EXT_ALIAS: Record<string, string> = {
  mjs: "js",
  cjs: "js",
  mts: "ts",
  cts: "ts",
};

const langOf = (path: string) => {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return EXT_ALIAS[ext] ?? ext;
};

export function CodeModal({ repoId, code, onClose }: CodeModalProps) {
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  // a failure here surfaces in the modal instead of pretending the file is
  // empty (missing endpoint / api not restarted)
  useEffect(() => {
    let cancelled = false;
    setContent(null);
    setError(null);
    api
      .fileContent(repoId, code.path)
      .then((r) => {
        if (!cancelled) setContent(r.content);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [repoId, code.path]);

  // one React node per line, tokenised by shiki (github light/dark paired
  // with the dashboard's [data-theme] via the dark: variant)
  const lines = useHighlightedCode(content ?? "", langOf(code.path));

  // land on the node's line once it exists in the DOM
  useEffect(() => {
    if (content === null) return;
    bodyRef.current
      ?.querySelector('[data-variant="highlighted"]')
      ?.scrollIntoView({ block: "center" });
  }, [content]);

  const start = code.startLine;
  const end = code.endLine ?? code.startLine;
  const hit = (n: number) => start !== null && end !== null && n >= start && n <= end;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="left-[calc(50%-4vw)] flex max-h-[85vh] w-[min(1040px,calc(100vw-2rem))] flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="shrink-0 gap-1 px-4 pt-4 pb-3">
          <DialogTitle className="truncate font-mono text-sm" title={code.path}>
            {code.path}
          </DialogTitle>
          {start !== null && (
            <p className="text-xs text-muted-foreground">
              lines {start}–{end ?? start}
            </p>
          )}
        </DialogHeader>
        <div ref={bodyRef} className="min-h-0 flex-1">
          {error ? (
            <p className="px-4 pb-4 text-sm text-[var(--red)]">{error}</p>
          ) : content === null ? (
            <div className="flex items-center justify-center p-10">
              <div className="spinner" />
            </div>
          ) : (
            <CodeBlock className="h-full rounded-none border-0">
              <CodeBlockCopyButton value={content} className="m-2" />
              <CodeBlockContent lineNumbers className="flex-1">
                {lines.map((line, i) => (
                  <CodeBlockLine key={i} variant={hit(i + 1) ? "highlighted" : "default"}>
                    {line}
                  </CodeBlockLine>
                ))}
              </CodeBlockContent>
            </CodeBlock>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
