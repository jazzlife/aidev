import { useSyncExternalStore } from 'react';

// Open state lives outside the panel so a button elsewhere (the workbench activity bar) can toggle
// the drawer when the floating edge handle is hidden.
let open = false;
const listeners = new Set<() => void>();

function setOpen(next: boolean) {
  if (next === open) return;
  open = next;
  for (const listener of listeners) listener();
}

/** Used by the workbench module's activity bar to open or close the quick settings drawer. */
export function toggleQuickSettings(next?: boolean) {
  setOpen(next ?? !open);
}

/** Used by QuickSettingsPanelView to read and change the shared open state. */
export function useQuickSettingsOpen(): [boolean, (next: boolean) => void] {
  const value = useSyncExternalStore(
    (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    () => open,
    () => false,
  );
  return [value, setOpen];
}
