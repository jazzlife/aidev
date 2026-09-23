import type { PendingPermissionRequest } from '@/modules/chat-core';
import { BottomSheet } from '@m/components/BottomSheet';
import { clampText } from '@m/lib/format';

type PermissionSheetProps = { request: PendingPermissionRequest | null; onDecide: (requestId: string, allow: boolean) => void };

/** Used by ChatScreen: tool permission prompt (Claude) surfaced as a sheet with allow/deny. */
export function PermissionSheet({ request, onDecide }: PermissionSheetProps) {
  if (!request) return null;
  const input = request.input && typeof request.input === 'object' ? JSON.stringify(request.input, null, 1) : String(request.input ?? '');
  return (
    <BottomSheet open onClose={() => onDecide(request.requestId, false)} title={`도구 허용: ${request.toolName}`}>
      <pre className="rounded-xl bg-elevated border border-line p-2 text-[12px] whitespace-pre-wrap break-words max-h-60 overflow-auto">{clampText(input, 3000)}</pre>
      <div className="flex gap-2 mt-3">
        <button type="button" onClick={() => onDecide(request.requestId, false)} className="flex-1 h-11 rounded-xl border border-line">거부</button>
        <button type="button" onClick={() => onDecide(request.requestId, true)} className="flex-1 h-11 rounded-xl bg-accent text-accent-ink font-semibold">허용</button>
      </div>
    </BottomSheet>
  );
}
