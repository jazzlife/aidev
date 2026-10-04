import { useEffect } from 'react';
import { Loader2, Mic, Square } from 'lucide-react';

import { useDictation, useVoiceStatus } from '@m/lib/voice';

/**
 * Used by ChatScreen in the composer row: 🎤 records, a second tap stops and the words land in the input. Shown only when
 * voice is on and a backend answers (the workbench's judgement); errors surface through `onError`.
 */
export function MicButton({ onText, onError, disabled }: { onText: (text: string) => void; onError: (message: string | null) => void; disabled?: boolean }) {
  const voice = useVoiceStatus();
  const dictation = useDictation(onText);
  useEffect(() => { onError(dictation.error); }, [dictation.error, onError]);
  if (!voice.enabled || (voice.backend !== 'own' && voice.backend !== 'server')) return null;
  const recording = dictation.state === 'recording';
  const busy = dictation.state === 'transcribing';
  return (
    <button type="button" disabled={disabled || busy} aria-label={recording ? '녹음 멈추기' : busy ? '받아쓰는 중' : '음성 입력'} aria-pressed={recording}
      onClick={() => { if (recording) dictation.stop(); else void dictation.start(); }}
      className={`m-touch flex items-center justify-center rounded-full disabled:opacity-60 ${recording ? 'text-danger' : 'text-muted'}`}>
      {busy ? <Loader2 size={19} className="animate-spin" /> : recording ? <Square size={16} className="m-pulse" fill="currentColor" /> : <Mic size={19} />}
    </button>
  );
}
