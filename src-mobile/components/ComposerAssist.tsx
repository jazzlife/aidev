import { useEffect, useMemo, useState } from 'react';
import { FileText, Slash, Sparkles } from 'lucide-react';

import { assistQuery, filterCommands, loadCommands, loadFiles, matchFiles, readCommandHistory, type MentionFile, type SlashCommand } from '@m/lib/composerAssist';

type Project = { projectId: string; fullPath: string };

/**
 * Used by ChatScreen above the composer: while the text starts with `/`, the commands; after an `@`, the project's
 * files. A tap inserts (`@path`, a skill's `/name `) or runs the command (`onCommand`).
 */
export function ComposerAssist({ draft, cursor, project, provider, onInsert, onCommand }: {
  draft: string; cursor: number; project: Project | null; provider: string;
  /** the composer's new text (the suggestion put in) */
  onInsert: (text: string) => void;
  onCommand: (command: SlashCommand) => void;
}) {
  const ask = project ? assistQuery(draft, cursor) : null;
  // the project's commands and files, once asked for (null: loading)
  const [commands, setCommands] = useState<SlashCommand[] | null>(null);
  const [files, setFiles] = useState<MentionFile[] | null>(null);
  // a list that could not load says so instead of staying empty
  const [error, setError] = useState<string | null>(null);
  const kind = ask?.kind ?? null;
  useEffect(() => { setCommands(null); setFiles(null); setError(null); }, [project?.projectId, provider]);
  useEffect(() => {
    if (!project || !kind) return undefined;
    let alive = true;
    if (kind === 'command' && commands === null) loadCommands(project, provider).then((list) => { if (alive) setCommands(list); }).catch((err: Error) => { if (alive) { setCommands([]); setError(err.message); } });
    if (kind === 'file' && files === null) loadFiles(project.projectId).then((list) => { if (alive) setFiles(list); }).catch((err: Error) => { if (alive) { setFiles([]); setError(err.message); } });
    return () => { alive = false; };
  }, [commands, files, kind, project, provider]);
  const history = useMemo(() => (project ? readCommandHistory(project.projectId) : {}), [project, kind]);   // re-read when the menu opens
  if (!ask || !project) return null;

  const row = 'flex w-full items-start gap-2 px-3 py-2 text-left active:bg-elevated';
  if (ask.kind === 'command') {
    const shown = commands ? filterCommands(commands, ask.query, history).slice(0, 8) : null;
    return (
      <ul className="mx-3 mb-1 max-h-[38dvh] overflow-y-auto rounded-xl border border-line bg-surface shadow-lg" data-testid="command-menu">
        {shown === null ? <li className="px-3 py-2 text-[13px] text-muted m-pulse">명령 불러오는 중…</li> : null}
        {shown?.length === 0 ? <li className="px-3 py-2 text-[13px] text-muted">{error ?? '맞는 명령이 없습니다'}</li> : null}
        {shown?.map((command) => (
          <li key={`${command.type}:${command.name}`}>
            <button type="button" className={row} onClick={() => { if (command.type === 'skill') onInsert(`${command.name} `); else onCommand(command); }}>
              {command.type === 'skill' ? <Sparkles size={15} className="mt-0.5 shrink-0 text-accent" /> : <Slash size={15} className="mt-0.5 shrink-0 text-muted" />}
              <span className="min-w-0 flex-1"><span className="block truncate font-mono text-[14px]">{command.name}</span>{command.description ? <span className="block truncate text-[12px] text-muted">{command.description}</span> : null}</span>
            </button>
          </li>
        ))}
      </ul>
    );
  }
  const shown = files ? matchFiles(files, ask.query, 8) : null;
  return (
    <ul className="mx-3 mb-1 max-h-[38dvh] overflow-y-auto rounded-xl border border-line bg-surface shadow-lg" data-testid="file-menu">
      {shown === null ? <li className="px-3 py-2 text-[13px] text-muted m-pulse">파일 불러오는 중…</li> : null}
      {shown?.length === 0 ? <li className="px-3 py-2 text-[13px] text-muted">{error ?? '맞는 파일이 없습니다'}</li> : null}
      {shown?.map((file) => (
        <li key={file.path}>
          <button type="button" className={row} onClick={() => onInsert(`${draft.slice(0, ask.start)}@${file.path} ${draft.slice(cursor)}`)}>
            <FileText size={15} className="mt-0.5 shrink-0 text-muted" />
            <span className="min-w-0 flex-1"><span className="block truncate text-[14px]">{file.name}</span><span className="block truncate text-[12px] text-muted">{file.path}</span></span>
          </button>
        </li>
      ))}
    </ul>
  );
}
