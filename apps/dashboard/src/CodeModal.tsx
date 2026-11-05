import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  CodeBlock,
  CodeBlockContent,
  CodeBlockCopyButton,
  CodeBlockLine,
} from "@/components/ui/code-block";
import { FileCodeIcon, XIcon } from "lucide-react";
import { Hint } from "@/components/ui/tooltip";
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

const splitPath = (path: string) => {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return i < 0 ? { dir: "", name: path } : { dir: path.slice(0, i), name: path.slice(i + 1) };
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
      ?.scrollIntoView({ block: "center", inline: "nearest" });
  }, [content]);

  const start = code.startLine;
  const end = code.endLine ?? code.startLine;
  const range =
    start === null || end === null
      ? null
      : start === end
        ? `line ${start}`
        : `lines ${start}–${end}`;
  const hit = (n: number) => start !== null && end !== null && n >= start && n <= end;

  const { dir, name } = splitPath(code.path);
  const lineCount = content === null ? null : content.replace(/\n$/, "").split("\n").length;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      {/* file viewer: toolbar + code surface + status bar, not a small dialog */}
      <DialogContent
        showCloseButton={false}
        className="code-modal gap-0 overflow-hidden p-0 sm:max-w-none"
      >
        <header className="code-modal-head">
          <span className="code-modal-icon" aria-hidden="true">
            <FileCodeIcon />
          </span>
          <div className="code-modal-file">
            <Hint side="bottom" label={code.path}>
              <DialogTitle className="code-modal-name">{name}</DialogTitle>
            </Hint>
            <Hint side="bottom" label={code.path}>
              <span className="code-modal-path mono">{dir || "./"}</span>
            </Hint>
          </div>
          <div className="code-modal-meta">
            <span className="code-chip">{langOf(code.path) || "text"}</span>
            {range && (
              <Hint label="Highlighted in the file">
                <span className="code-chip code-chip-accent">{range}</span>
              </Hint>
            )}
            {lineCount !== null && <span className="code-chip">{lineCount} lines</span>}
          </div>
          <div className="code-modal-actions">
            {content !== null && <CodeBlockCopyButton value={content} />}
            <Hint label="Close">
              <DialogClose render={<Button variant="ghost" size="icon-sm" aria-label="Close" />}>
                <XIcon />
              </DialogClose>
            </Hint>
          </div>
        </header>
        <DialogDescription className="sr-only">
          Contents of {code.path}
          {range ? `, ${range}` : ""}
        </DialogDescription>

        <div ref={bodyRef} className="code-modal-body">
          {error ? (
            <p className="code-modal-error">{error}</p>
          ) : content === null ? (
            <div className="code-modal-loading">
              <div className="spinner" />
              <span>Loading file…</span>
            </div>
          ) : (
            <CodeBlock className="h-full rounded-none border-0">
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

        <footer className="code-modal-foot">
          <Hint side="top" label={code.path}>
            <span className="code-modal-foot-path mono">{code.path}</span>
          </Hint>
          <span className="code-modal-hint">{range ? `focused on ${range}` : "whole file"}</span>
          <span className="code-modal-hint code-modal-esc">
            <kbd>Esc</kbd> to close
          </span>
        </footer>
      </DialogContent>
    </Dialog>
  );
}
