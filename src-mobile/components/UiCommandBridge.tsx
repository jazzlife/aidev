import { useEffect, useState } from 'react';

import { api } from '@/modules/chat-core';
import { useUiCommands, type UiCommand } from '@/modules/aidev-router';
import { useGo } from '@m/lib/nav';

/**
 * App control on the phone (2026-10-02): what an agent shows the user (nadovibe_show) opens here — the PC's live screen
 * (a window or the whole screen), the preview, the debugger, PC pairing, settings, a project, an agent — with the agent's
 * note on top for a few seconds. Back returns to where the user was (the opened screen's opener).
 */
export function UiCommandBridge() {
  const go = useGo();
  const [note, setNote] = useState<string | null>(null);
  const open = async (cmd: UiCommand) => {
    const p = cmd.params;
    if (cmd.view === 'screen' && p.target !== null && p.target !== undefined) go(`/screen/${p.target}?w=${encodeURIComponent(String(p.window ?? 'full'))}`);
    else if (cmd.view === 'preview') go(p.target && p.port ? `/preview?p=${p.target}:${p.port}` : '/preview');
    else if (cmd.view === 'debug') go(p.session ? `/debug?s=${encodeURIComponent(String(p.session))}` : '/debug');
    else if (cmd.view === 'pcs') go('/pcs');
    else if (cmd.view === 'settings') go('/settings');
    else if (cmd.view === 'catalog') go(typeof p.agent === 'number' ? `/catalog/${p.agent}` : '/catalog');
    else if (cmd.view === 'project' && p.project) {
      const key = String(p.project).toLowerCase();
      try {
        const list = await (await api.projects()).json() as Array<{ projectId: string; displayName: string; fullPath: string }>;
        const hit = list.find((x) => String(x.projectId).toLowerCase() === key) ?? list.find((x) => x.displayName.toLowerCase() === key);
        if (hit) go(`/projects/${encodeURIComponent(hit.projectId)}`, { state: { project: hit } });
      } catch { /* the project list is unavailable: stay */ }
    }
    if (cmd.note) setNote(cmd.note);
  };
  useUiCommands((cmd) => { void open(cmd); });
  useEffect(() => {
    if (!note) return undefined;
    const timer = window.setTimeout(() => setNote(null), 8000);
    return () => window.clearTimeout(timer);
  }, [note]);
  return note ? (
    <div role="status" className="fixed inset-x-4 top-[calc(env(safe-area-inset-top)+56px)] z-[60] rounded-xl border border-accent/40 bg-surface px-4 py-3 text-[14px] shadow-lg" data-testid="agent-ui-note">
      <span className="mr-2 font-semibold text-accent">agent</span>{note}
    </div>
  ) : null;
}
