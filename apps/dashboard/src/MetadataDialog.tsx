import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  BoxIcon,
  CalendarIcon,
  ClockIcon,
  FileCodeIcon,
  FileIcon,
  FolderGit2Icon,
  FolderIcon,
  GitBranchIcon,
  GitForkIcon,
  XIcon,
  type LucideIcon,
} from "lucide-react";
import { Hint } from "@/components/ui/tooltip";
import type { DiagnosticDto, IndexStatusDto } from "./api";
import type { CodeTarget } from "./CodeModal";

interface MetadataDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  status: IndexStatusDto | null;
  repoName: string | null;
  repoPath: string | null;
  diagnostics: DiagnosticDto[];
  /** snapshot mode has no API to serve the source file */
  offline: boolean;
  onOpenCode: (code: CodeTarget) => void;
}

export function MetadataDialog({
  open,
  onOpenChange,
  status,
  repoName,
  repoPath,
  diagnostics,
  offline,
  onOpenCode,
}: MetadataDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showCloseButton={false} className="metadata-modal gap-0 overflow-hidden p-0">
        <header className="metadata-head">
          <DialogTitle className="metadata-title">Metadata</DialogTitle>
          <Hint label="Close">
            <DialogClose render={<Button variant="ghost" size="icon-sm" aria-label="Close" />}>
              <XIcon />
            </DialogClose>
          </Hint>
        </header>
        <DialogDescription className="metadata-note">
          Repository index summary plus unresolved calls and parse errors from the last run. Absence
          of a diagnostic is not proof of complete coverage.
        </DialogDescription>

        <div className="metadata-body">
          {status ? (
            <>
              <dl className="metadata-grid">
                <MetaItem
                  icon={FolderGit2Icon}
                  tone="repository"
                  label="Repository"
                  value={repoName ?? "—"}
                />
                <MetaItem icon={FolderIcon} tone="root" label="Root" value={repoPath ?? "—"} mono />
                <MetaItem
                  icon={GitBranchIcon}
                  tone="revision"
                  label="Revision"
                  value={status.lastRevision?.slice(0, 12) ?? "—"}
                  mono
                />
                <MetaItem
                  icon={CalendarIcon}
                  tone="indexed"
                  label="Indexed"
                  value={
                    status.indexedAt
                      ? status.indexedAt.slice(0, 19).replace("T", " ")
                      : "never indexed"
                  }
                />
                <MetaItem
                  icon={ClockIcon}
                  tone="duration"
                  label="Duration"
                  value={status.durationMs !== null ? `${status.durationMs} ms` : "—"}
                />
                <MetaItem
                  icon={FileIcon}
                  tone="files"
                  label="Files"
                  value={status.fileCount.toLocaleString()}
                />
                <MetaItem
                  icon={BoxIcon}
                  tone="nodes"
                  label="Nodes"
                  value={status.nodeCount.toLocaleString()}
                />
                <MetaItem
                  icon={GitForkIcon}
                  tone="edges"
                  label="Edges"
                  value={status.edgeCount.toLocaleString()}
                />
              </dl>

              <section className="metadata-section">
                <h3>
                  Diagnostics <span className="count">({diagnostics.length})</span>
                </h3>
                {diagnostics.length === 0 ? (
                  <p className="muted">No diagnostics were recorded for this index.</p>
                ) : (
                  <ul className="diagnostics-list">
                    {diagnostics.map((diagnostic, i) => (
                      <li
                        key={`${diagnostic.kind}-${diagnostic.file ?? ""}-${diagnostic.line ?? 0}-${i}`}
                        className="diagnostic-item"
                      >
                        <span className={`pill diag-${diagnostic.kind}`}>
                          {diagnostic.kind.replace(/-/g, " ")}
                        </span>
                        <span className="diagnostic-message">{diagnostic.message}</span>
                        {diagnostic.file &&
                          (offline ? (
                            <span className="diagnostic-file mono">
                              <FileCodeIcon aria-hidden="true" />
                              {diagnostic.file}
                              {diagnostic.line ? `:${diagnostic.line}` : ""}
                            </span>
                          ) : (
                            <Hint
                              side="left"
                              label={`Open ${diagnostic.file}${diagnostic.line ? `:${diagnostic.line}` : ""}`}
                            >
                              <button
                                className="diagnostic-file mono"
                                onClick={() =>
                                  onOpenCode({
                                    path: diagnostic.file!,
                                    startLine: diagnostic.line ?? null,
                                    endLine: diagnostic.line ?? null,
                                  })
                                }
                              >
                                <FileCodeIcon aria-hidden="true" />
                                {diagnostic.file}
                                {diagnostic.line ? `:${diagnostic.line}` : ""}
                              </button>
                            </Hint>
                          ))}
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </>
          ) : (
            <p className="muted">No index metadata is available yet.</p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function MetaItem({
  icon: Icon,
  tone,
  label,
  value,
  mono = false,
}: {
  icon: LucideIcon;
  tone: string;
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="metadata-item" data-tone={tone}>
      <dt>
        <Icon className="metadata-item-icon" aria-hidden="true" />
        {label}
      </dt>
      <dd className={mono ? "mono" : undefined}>{value}</dd>
    </div>
  );
}
