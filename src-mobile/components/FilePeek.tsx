import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, FileText, Search } from 'lucide-react';

import { api } from '@/modules/chat-core';
import { BottomSheet } from '@m/components/BottomSheet';
import { loadHighlighter } from '@m/lib/highlight';
import { languageFor, type FileRef } from '@m/lib/peek';

// fixed row height: the line gutter, the highlight bar and "jump to line" all count in it
const LINE_PX = 18;
const PAD_PX = 8;
// larger files are shown as plain text (highlighting them would stall the phone)
const HIGHLIGHT_MAX_CHARS = 200_000;
const SEARCH_LIMIT = 60;

type FileNode = { name: string; path: string; type: 'file' | 'directory'; children?: FileNode[] };
type Project = { projectId: string; projectPath: string };

const relativeTo = (root: string, path: string) => (root && path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path);

function flattenFiles(nodes: FileNode[], into: string[] = []): string[] {
  for (const node of nodes) {
    if (node.type === 'file') into.push(node.path);
    else if (node.children) flattenFiles(node.children, into);
  }
  return into;
}

async function readError(response: Response) {
  if (response.status === 404) return '파일이 없습니다';
  if (response.status === 403) return '프로젝트 밖의 파일은 볼 수 없습니다';
  try { const body = await response.json() as { error?: string }; return body.error || `읽기 실패 (${response.status})`; } catch { return `읽기 실패 (${response.status})`; }
}

/** The file itself: line numbers, highlight.js colours, the referenced line marked and scrolled into view. */
function FileBody({ project, file }: { project: Project; file: FileRef }) {
  // the text as read (null while loading); kept apart from `html` so plain text shows before the highlighter loads
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // highlight.js markup for `content`, when the language is one of the shipped eight
  const [html, setHtml] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // a different file remounts FileBody (key), so the state starts empty here
    let cancelled = false;
    api.readFile(project.projectId, file.path).then(async (response) => {
      if (!response.ok) { const message = await readError(response); if (!cancelled) setError(message); return; }
      const body = await response.json() as { content?: string };
      if (!cancelled) setContent(body.content ?? '');
    }).catch(() => { if (!cancelled) setError('파일을 불러오지 못했습니다'); });
    return () => { cancelled = true; };
  }, [project.projectId, file.path]);

  useEffect(() => {
    const language = languageFor(file.path);
    if (content === null || !language || content.length > HIGHLIGHT_MAX_CHARS) return undefined;
    let cancelled = false;
    // highlight.js escapes the source, so its markup is safe to inject
    loadHighlighter().then((hljs) => { if (!cancelled) setHtml(hljs.highlight(content, { language, ignoreIllegals: true }).value); }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [content, file.path]);

  const lineCount = content === null ? 0 : Math.max(1, (content.endsWith('\n') ? content.slice(0, -1) : content).split('\n').length);
  const targetLine = file.line && file.line <= lineCount ? file.line : null;
  useEffect(() => {
    const element = scrollRef.current;
    if (!element || content === null || !targetLine) return;
    element.scrollTop = Math.max(0, PAD_PX + (targetLine - 1) * LINE_PX - element.clientHeight / 3);
  }, [content, targetLine]);

  if (error) return <div className="py-6 text-center text-[14px] text-danger">{error}</div>;
  if (content === null) return <div className="py-6 text-center text-[14px] text-muted m-pulse">불러오는 중…</div>;
  const numbers = Array.from({ length: lineCount }, (_, index) => index + 1).join('\n');
  return (
    <div ref={scrollRef} className="h-[65dvh] overflow-auto rounded-lg border border-line bg-elevated" data-testid="file-peek-body">
      <div className="relative flex min-w-max font-mono text-[12px]" style={{ lineHeight: `${LINE_PX}px`, padding: `${PAD_PX}px 0` }}>
        {targetLine ? <div className="pointer-events-none absolute inset-x-0 bg-accent/15" style={{ top: PAD_PX + (targetLine - 1) * LINE_PX, height: LINE_PX }} /> : null}
        <pre className="relative m-0 select-none pl-2 pr-3 text-right text-muted">{numbers}</pre>
        {html !== null
          ? <pre className="m-hljs relative m-0 pr-4" dangerouslySetInnerHTML={{ __html: html }} />
          : <pre className="relative m-0 pr-4">{content}</pre>}
      </div>
    </div>
  );
}

/** Finding a file to peek: the project's files (gitignore respected), filtered by name or path. */
function FileSearch({ project, onPick }: { project: Project; onPick: (path: string) => void }) {
  // every file of the project, loaded once per open sheet
  const [files, setFiles] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  useEffect(() => {
    let cancelled = false;
    api.getFiles(project.projectId).then(async (response) => {
      if (!response.ok) throw new Error(await readError(response));
      const tree = await response.json() as FileNode[];
      if (!cancelled) setFiles(flattenFiles(Array.isArray(tree) ? tree : []));
    }).catch((err: Error) => { if (!cancelled) setError(err.message || '파일 목록을 불러오지 못했습니다'); });
    return () => { cancelled = true; };
  }, [project.projectId]);
  const matches = useMemo(() => {
    if (!files) return [];
    const needle = query.trim().toLowerCase();
    const scored = files.map((path) => {
      const relative = relativeTo(project.projectPath, path);
      const lower = relative.toLowerCase();
      const name = lower.slice(lower.lastIndexOf('/') + 1);
      // file-name hits first, then path hits; shorter paths first within each
      const score = !needle ? 1 : name.startsWith(needle) ? 3 : name.includes(needle) ? 2 : lower.includes(needle) ? 1 : 0;
      return { path, relative, score };
    }).filter((entry) => entry.score > 0);
    scored.sort((a, b) => b.score - a.score || a.relative.length - b.relative.length);
    return scored.slice(0, SEARCH_LIMIT);
  }, [files, query, project.projectPath]);
  return (
    <div className="space-y-2">
      <label className="flex h-11 items-center gap-2 rounded-xl border border-line bg-elevated px-3">
        <Search size={16} className="text-muted" />
        <input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="파일 이름이나 경로" className="flex-1 bg-transparent text-[16px] outline-none placeholder:text-muted" />
      </label>
      {error ? <div className="text-[13px] text-danger">{error}</div> : null}
      {files === null && !error ? <div className="py-4 text-center text-[13px] text-muted m-pulse">파일 목록을 불러오는 중…</div> : null}
      {files && !matches.length ? <div className="py-4 text-center text-[13px] text-muted">일치하는 파일이 없습니다</div> : null}
      <div className="divide-y divide-line">
        {matches.map((entry) => (
          <button key={entry.path} type="button" onClick={() => onPick(entry.path)} className="flex w-full items-center gap-2 py-2.5 text-left">
            <FileText size={15} className="shrink-0 text-muted" />
            <span className="min-w-0 flex-1 truncate text-[14px]">{entry.relative}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

type FilePeekProps = {
  open: boolean;
  onClose: () => void;
  /** the chat's project; without one there is nothing to read */
  project: Project | null;
  /** the file (and line) on screen; null shows the search */
  file: FileRef | null;
  /** the file was picked from the search here, so "back" returns to it */
  fromSearch: boolean;
  /** a search pick (a ref) or back to the search (null) */
  onFile: (file: FileRef | null) => void;
};

/**
 * Used by ChatScreen (C-05): the phone's read-only window on the project's files — a tapped `path:line` in the
 * chat, a file a tool read or wrote, or one found by search. Editing stays in the workbench.
 */
export function FilePeek({ open, onClose, project, file, fromSearch, onFile }: FilePeekProps) {
  const title = file ? (
    <div className="flex min-w-0 items-center gap-1">
      {fromSearch ? <button type="button" aria-label="검색으로" onClick={() => onFile(null)} className="-ml-2 flex h-8 w-8 items-center justify-center text-muted"><ChevronLeft size={20} /></button> : null}
      <span className="min-w-0 truncate">{relativeTo(project?.projectPath ?? '', file.path)}{file.line ? <span className="text-muted">:{file.line}</span> : null}</span>
    </div>
  ) : '파일 찾기';
  return (
    <BottomSheet open={open} onClose={onClose} title={title}>
      {!project ? <div className="py-6 text-center text-[14px] text-muted">프로젝트를 먼저 선택하세요</div>
        : file ? <FileBody key={`${file.path}:${file.line ?? ''}`} project={project} file={file} />
          : <FileSearch project={project} onPick={(path) => onFile({ path, line: null })} />}
    </BottomSheet>
  );
}
