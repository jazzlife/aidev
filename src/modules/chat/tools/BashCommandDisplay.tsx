import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronRight, Copy, Check } from 'lucide-react';

import { cn,copyTextToClipboard } from '@/shared/utils';
import { ToolStatusBadge } from '@/modules/chat/tools/ToolStatusBadge';
import { useIsExportingTranscript } from '@/modules/chat/context/TranscriptRenderContext';
import type { ToolStatus } from '@/shared/types';

type BashCommandDisplayProps = {
  command: string;
  description?: string;
  /** Combined stdout/stderr from the tool result (empty while running). */
  output?: string;
  isError?: boolean;
  status?: ToolStatus;
  defaultOpen?: boolean;
};

/**
 * Codex-in-VSCode style command row: a compact, single-line row with a chevron
 * on the left. When the model supplied a plain-language `description`, that is
 * what the collapsed row shows — raw shell syntax (regex-heavy greps, sed
 * ranges, flag soup) reads as noise to most users, especially on a narrow
 * screen, while "Search the router hooks for pendingCreate handling" reads as
 * what the agent is actually doing. The raw command is never lost: expanding
 * the row always reveals it in full, alongside any output. When no description
 * was given, the row falls back to showing the (truncated) command itself, as
 * before.
 *
 * Theme-integrated surfaces keep it clean in both light and dark mode;
 * consecutive commands stack tightly into a clean list.
 *
 * Rendered by chat's ToolRenderer for shell tools (Bash and PowerShell).
 */
export const BashCommandDisplay: React.FC<BashCommandDisplayProps> = ({
  command,
  description,
  output,
  isError = false,
  status,
  defaultOpen = false,
}) => {
  const { t } = useTranslation();
  const trimmedOutput = (output || '').replace(/\s+$/, '');
  const hasOutput = trimmedOutput.length > 0;
  const outputLineCount = hasOutput ? trimmedOutput.split('\n').length : 0;
  const hasDescription = Boolean(description && description.trim());
  const isRunning = status === 'running';
  // `open` is raised by an effect once output arrives (below). A document is
  // rendered without effects, so it would show every command and no output.
  const isExporting = useIsExportingTranscript();
  const [openState, setOpen] = useState(false);
  const open = openState || isExporting;
  const [copied, setCopied] = useState(false);

  // Output often arrives after this component first mounts, so apply the
  // auto-open intent once when there is finally something to show. After that
  // the user is in control of the toggle. Errors intentionally do NOT
  // auto-expand — the red border and status badge already signal the failure,
  // and the output stays one click away.
  const autoAppliedRef = useRef(false);
  useEffect(() => {
    if (!autoAppliedRef.current && hasOutput && defaultOpen) {
      autoAppliedRef.current = true;
      setOpen(true);
    }
  }, [hasOutput, defaultOpen]);

  // The row is always expandable: when a description is standing in for the
  // raw command, expanding is the only way to see what actually ran, and a
  // truncated command with no output still deserves a way to read it in full.
  const toggle = () => {
    setOpen((prev) => !prev);
  };

  const handleCopy = async (event: React.MouseEvent) => {
    event.stopPropagation();
    const didCopy = await copyTextToClipboard(command);
    if (!didCopy) return;
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div
      className={cn(
        'group/cmd overflow-hidden rounded-lg border bg-muted/40 backdrop-blur-sm transition-all duration-200',
        isError ? 'border-red-500/30' : 'border-border/60',
        !open && 'hover:border-border hover:bg-muted/60',
        open && 'bg-muted/50 shadow-sm',
      )}
    >
      {/* Command header — always clickable; expanding is the only way to read
          the raw command when a description is standing in for it. */}
      <div
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={toggle}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            toggle();
          }
        }}
        className="flex cursor-pointer items-center gap-2 px-2.5 py-1.5 outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        <ChevronRight
          className={cn(
            'h-3.5 w-3.5 flex-shrink-0 text-muted-foreground/70 transition-transform duration-200',
            open && 'rotate-90',
          )}
        />
        <span className="flex-shrink-0 select-none font-mono text-xs font-semibold text-emerald-500 dark:text-emerald-400">
          $
        </span>
        {/* Not a <code> tag: the global `.chat-message code` rule forces
            `white-space: pre-wrap !important`, which would defeat `truncate`
            and render collapsed multi-line commands in full.
            Collapsed: a plain-language description (when the model gave one)
            takes the primary slot instead of raw shell syntax. Expanded: the
            full command always takes over, since that's the one place the raw
            text is guaranteed to be reachable. */}
        <span
          className={cn(
            'min-w-0 flex-1 text-xs text-foreground',
            open
              ? 'whitespace-pre-wrap break-all font-mono'
              : hasDescription
                ? 'truncate'
                : 'truncate font-mono',
          )}
        >
          {open || !hasDescription ? command : description}
        </span>

        {isRunning && (
          <span className="h-2.5 w-2.5 flex-shrink-0 animate-spin rounded-full border-[1.5px] border-muted-foreground/30 border-t-emerald-400" />
        )}
        {status && status !== 'running' && <ToolStatusBadge status={status} className="flex-shrink-0" />}
        {!open && hasOutput && !isRunning && (
          <span className="flex-shrink-0 text-[10px] tabular-nums text-muted-foreground/70 transition-opacity group-hover/cmd:opacity-0">
            {outputLineCount} {outputLineCount === 1 ? 'line' : 'lines'}
          </span>
        )}

        <button
          onClick={handleCopy}
          onKeyDown={(event) => event.stopPropagation()}
          className="flex-shrink-0 rounded p-0.5 text-muted-foreground/60 opacity-0 transition-all hover:bg-foreground/10 hover:text-foreground focus:opacity-100 group-hover/cmd:opacity-100"
          title={t('chat:misc.copyCommand')}
          aria-label={t('chat:misc.copyCommand')}
        >
          {copied ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : <Copy className="h-3.5 w-3.5" />}
        </button>
      </div>

      {/* Expanded detail: the description (if the header is now showing the
          raw command instead) and the output (if any). */}
      {open && (hasDescription || hasOutput) && (
        <div className="settings-content-enter border-t border-border/50 bg-background/50">
          {hasDescription && (
            <div className="px-3 pt-2 text-[11px] italic text-muted-foreground/70">{description}</div>
          )}
          {hasOutput && (
            <pre
              className={cn(
                'max-h-80 overflow-auto whitespace-pre-wrap break-all px-3 py-2 font-mono text-xs leading-relaxed',
                isError ? 'text-red-600 dark:text-red-400' : 'text-muted-foreground',
              )}
            >
              {trimmedOutput}
            </pre>
          )}
        </div>
      )}
    </div>
  );
};
