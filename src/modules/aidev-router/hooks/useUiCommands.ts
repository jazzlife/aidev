import { useEffect, useRef } from 'react';

import { aidevApi, type UiCommand } from '@/modules/aidev-router/api';
import { routingStore } from '@/modules/aidev-router/store';

/**
 * App control (2026-10-02): carries out what an agent asks the user's NadoVibe page to do — open a PC's live screen,
 * a preview, the debugger, PC pairing, settings, a project, an agent — by long-polling the gateway while the page is
 * visible. Page settings (the routing mode) are applied here; every `show` goes to the app's own `onShow`.
 * Each page starts from "now", so nothing shown before it opened is replayed.
 */
const CLIENT_KEY = 'aidev.ui.client';

function clientId() {
  try {
    const existing = sessionStorage.getItem(CLIENT_KEY);
    if (existing) return existing;
    const id = `c${Math.random().toString(36).slice(2, 10)}`;
    sessionStorage.setItem(CLIENT_KEY, id);
    return id;
  } catch {
    return `c${Math.random().toString(36).slice(2, 10)}`;
  }
}

/** Used by the workbench layout and the mobile app shell. */
export function useUiCommands(onShow: (command: UiCommand) => void, enabled = true) {
  const showRef = useRef(onShow);
  useEffect(() => { showRef.current = onShow; });
  useEffect(() => {
    if (!enabled) return undefined;
    const client = clientId();
    const abort = new AbortController();
    let after = 0;
    let stopped = false;
    const loop = async () => {
      while (!stopped) {
        if (document.visibilityState !== 'visible') {
          await new Promise((r) => setTimeout(r, 1500));
          continue;
        }
        try {
          const r = await aidevApi.uiCommands(after, client, 25, abort.signal);
          after = r.last;
          for (const command of r.commands) {
            if (command.action === 'set' && command.params.key === 'routing_mode') {
              const mode = command.params.value;
              if (mode === 'auto' || mode === 'manual' || mode === 'off') routingStore.setMode(mode);
            } else if (command.action === 'show') {
              showRef.current(command);
            }
          }
        } catch {
          if (stopped) return;
          await new Promise((r) => setTimeout(r, 5000));
        }
      }
    };
    void loop();
    return () => { stopped = true; abort.abort(); };
  }, [enabled]);
}
