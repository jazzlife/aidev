import { useEffect, useState } from 'react';
import { Copy, GitFork, Pencil, Volume2 } from 'lucide-react';

import { voicePlayer, type NormalizedMessage } from '@/modules/chat-core';
import { BottomSheet } from '@m/components/BottomSheet';
import { sheetButton } from '@m/components/ConversationActions';

/** The message a long-press picked: its text as shown, and the message itself. */
export type MessageTarget = { text: string; message: NormalizedMessage };

async function copyToClipboard(text: string) {
  try { await navigator.clipboard.writeText(text); }
  catch {
    // older WebViews: a temporary textarea (selection is allowed in text fields)
    const area = document.createElement('textarea'); area.value = text; document.body.appendChild(area); area.select(); document.execCommand('copy'); area.remove();
  }
}

/**
 * Used by ChatScreen (a message held down): copy; read aloud (the agent's replies, the workbench's player); and for a
 * sent message the engine can rewind to — edit and send again, or fork the conversation up to it.
 */
export function MessageActions({ target, onClose, canEdit, canFork, onEdit, onFork }: {
  target: MessageTarget | null; onClose: () => void;
  canEdit: boolean; canFork: boolean;
  onEdit: (target: MessageTarget) => void; onFork: (target: MessageTarget) => void;
}) {
  // "복사했습니다" for a moment before the sheet closes
  const [copied, setCopied] = useState(false);
  useEffect(() => { setCopied(false); }, [target]);
  if (!target) return null;
  const isAssistant = target.message.role !== 'user';
  const copy = async () => { await copyToClipboard(target.text); setCopied(true); setTimeout(onClose, 700); };
  return (
    <BottomSheet open onClose={onClose} title="메시지">
      {target.text ? <div className="text-[13px] text-muted line-clamp-4 whitespace-pre-wrap mb-2">{target.text}</div> : null}
      <div className="space-y-1" data-testid="message-actions">
        {target.text ? <button type="button" className={sheetButton} onClick={() => { void copy(); }}><Copy size={18} /> {copied ? '복사했습니다' : '복사'}</button> : null}
        {isAssistant && target.text ? (
          // unlock in the tap itself: iOS plays audio only from a user gesture
          <button type="button" className={sheetButton} onClick={() => { voicePlayer.unlock(); voicePlayer.toggle(target.text); onClose(); }}><Volume2 size={18} /> 읽어 주기</button>
        ) : null}
        {canEdit ? <button type="button" className={sheetButton} onClick={() => { onEdit(target); onClose(); }}><Pencil size={18} /> 수정 후 다시 보내기</button> : null}
        {canFork ? <button type="button" className={sheetButton} onClick={() => { onFork(target); onClose(); }}><GitFork size={18} /> 여기서 분기<span className="ml-auto text-[12px] text-muted">이 메시지까지 새 대화로</span></button> : null}
      </div>
    </BottomSheet>
  );
}
