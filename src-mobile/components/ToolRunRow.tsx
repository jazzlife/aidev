import { useState } from 'react';
import { ChevronDown, ChevronRight, Loader2, Wrench } from 'lucide-react';

import type { NormalizedMessage } from '@/modules/chat-core';
import { MessageBubble, type PeekHandlers } from '@m/components/MessageBubble';
import { describeToolRun, isWorkerTool, type ToolRun } from '@m/lib/toolRuns';
import { fileEditFromTool } from '@m/lib/peek';

type ToolRunRowProps = {
  run: ToolRun;
  results: Map<string, NormalizedMessage>;
} & PeekHandlers;

/**
 * Used by MessageList: one collapsed row for a stretch of tool calls — "작업 5단계 · Bash 3 · Read 2", with the
 * number of files changed and a spinner while the last call has no result yet. Tapping it shows the calls
 * (each its usual card) so nothing is lost, but the conversation reads as prose by default.
 */
export function ToolRunRow({ run, results, onPeekFile, onPeekDiff, projectPath }: ToolRunRowProps) {
  const [open, setOpen] = useState(false);
  const tools = run.messages.filter(isWorkerTool);
  const last = tools[tools.length - 1];
  const working = Boolean(last?.toolId) && !results.has(last.toolId as string);
  const edited = new Set(tools.map((message) => fileEditFromTool(message.toolName, message.toolInput)?.path).filter(Boolean));
  const failed = tools.filter((message) => message.toolId && results.get(message.toolId)?.toolResult?.isError).length;
  return (
    <div className="px-3 py-0.5" data-testid="tool-run" data-count={run.toolCount}>
      <button type="button" onClick={() => setOpen((value) => !value)} aria-expanded={open} className={`w-full text-left rounded-xl border px-3 py-2 flex items-center gap-2 bg-surface ${failed ? 'border-danger/50' : 'border-line'}`}>
        {working ? <Loader2 size={14} className="shrink-0 animate-spin text-accent" /> : <Wrench size={14} className="shrink-0 text-muted" />}
        <span className="flex-1 min-w-0">
          <span className="text-[13px] font-medium">작업 {run.toolCount}단계{edited.size ? ` · 파일 ${edited.size}개 변경` : ''}{failed ? ` · 오류 ${failed}` : ''}</span>
          <span className="block text-[12px] text-muted truncate">{describeToolRun(run)}</span>
        </span>
        {open ? <ChevronDown size={16} className="text-muted" /> : <ChevronRight size={16} className="text-muted" />}
      </button>
      {open ? (
        <div className="mt-1 -mx-3 border-l-2 border-line/70 ml-1">
          {run.messages.map((message) => <MessageBubble key={message.id} message={message} result={message.toolId ? results.get(message.toolId) : null} onPeekFile={onPeekFile} onPeekDiff={onPeekDiff} projectPath={projectPath} />)}
        </div>
      ) : null}
    </div>
  );
}
