import { Check } from 'lucide-react';

import { BottomSheet } from '@m/components/BottomSheet';
import { MODE_LABELS } from '@m/lib/chatOptions';

/** Used by ChatScreen (the composer's mode pill): how much the agent may do without asking, for this conversation. */
export function PermissionModeSheet({ open, onClose, modes, mode, onChoose }: { open: boolean; onClose: () => void; modes: string[]; mode: string; onChoose: (mode: string) => void }) {
  return (
    <BottomSheet open={open} onClose={onClose} title="권한 모드 · 이 대화">
      <ul className="space-y-1" data-testid="permission-modes">
        {modes.map((value) => {
          const label = MODE_LABELS[value] ?? { label: value, description: '' };
          return (
            <li key={value}>
              <button type="button" onClick={() => { onChoose(value); onClose(); }} aria-pressed={value === mode}
                className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left ${value === mode ? 'bg-elevated' : 'active:bg-elevated'}`}>
                <span className="min-w-0 flex-1">
                  <span className={`block text-[15px] ${value === 'bypassPermissions' ? 'text-danger' : ''}`}>{label.label}</span>
                  {label.description ? <span className="block text-[12px] text-muted">{label.description}</span> : null}
                </span>
                {value === mode ? <Check size={18} className="shrink-0 text-accent" /> : null}
              </button>
            </li>
          );
        })}
      </ul>
    </BottomSheet>
  );
}
