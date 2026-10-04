import { useCallback, useEffect, useRef, useState } from 'react';

import { api, readUserPreference, subscribeToUserPreferences, writeUserPreference } from '@/modules/chat-core';
import { transcribeVoice } from '@/shared/api';
import { readVoiceConfig, VOICE_CONFIG_SYNC_EVENT } from '@/shared/voiceConfig';

/**
 * Voice on the phone (C-12.6, C-12.9), judged like the workbench's `useVoiceAvailable` without its UI-preferences
 * context: the `voiceEnabled` UI preference (server-synced, shared with the workbench) and a voice backend — the user's
 * own OpenAI-compatible endpoint on this device, or the runtime's proxy when `/api/voice/health` says it is configured.
 */
type UiPreferences = Record<string, unknown> & { voiceEnabled?: boolean };

export function readVoiceEnabled(): boolean {
  return Boolean(readUserPreference<UiPreferences>('uiPreferences', {}).voiceEnabled);
}

/** Used by the settings screen: turns voice on or off for this account (the workbench's switch too). */
export function writeVoiceEnabled(enabled: boolean) {
  writeUserPreference('uiPreferences', { ...readUserPreference<UiPreferences>('uiPreferences', {}), voiceEnabled: enabled });
}

let healthRequest: Promise<boolean> | null = null;
/** Whether the runtime's voice proxy has a backend (asked once per page; a failure is asked again next time). */
export function checkVoiceHealth(): Promise<boolean> {
  healthRequest ??= api.voice.health().then(async (response) => {
    if (!response.ok) throw new Error(`voice health ${response.status}`);
    const body = await response.json() as { configured?: boolean };
    return body.configured === true;
  }).catch(() => { healthRequest = null; return false; });
  return healthRequest;
}

export type VoiceStatus = { enabled: boolean; backend: 'own' | 'server' | 'none' | 'checking' };

/** Used by the composer (🎤 only when usable) and the settings screen (what is missing). */
export function useVoiceStatus(): VoiceStatus {
  // the preference, re-read when it changes on this device or comes from the server
  const [enabled, setEnabled] = useState(readVoiceEnabled);
  // where speech goes, once known
  const [backend, setBackend] = useState<VoiceStatus['backend']>('checking');
  useEffect(() => subscribeToUserPreferences(() => setEnabled(readVoiceEnabled())), []);
  useEffect(() => {
    let alive = true;
    const check = () => {
      if (readVoiceConfig().baseUrl.trim()) { setBackend('own'); return; }
      setBackend('checking');
      void checkVoiceHealth().then((ok) => { if (alive) setBackend(ok ? 'server' : 'none'); });
    };
    check();
    window.addEventListener(VOICE_CONFIG_SYNC_EVENT, check);
    return () => { alive = false; window.removeEventListener(VOICE_CONFIG_SYNC_EVENT, check); };
  }, []);
  return { enabled, backend };
}

const MIME_CANDIDATES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus', 'audio/ogg'];
function pickMime(): string {
  for (const type of MIME_CANDIDATES) {
    try { if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(type)) return type; } catch { /* some iOS versions throw */ }
  }
  return '';
}

export type DictationState = 'idle' | 'recording' | 'transcribing';

/**
 * Used by the mic button: tap to record, tap again to stop; the speech comes back as text. Recording starts inside the
 * tap (iOS allows the microphone only from a user gesture).
 */
export function useDictation(onText: (text: string) => void) {
  // idle → recording → transcribing → idle
  const [state, setState] = useState<DictationState>('idle');
  // why the last attempt gave no text
  const [error, setError] = useState<string | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const gone = useRef(false);
  const stopTracks = () => { stream.current?.getTracks().forEach((track) => track.stop()); stream.current = null; };
  useEffect(() => () => { gone.current = true; if (recorder.current?.state === 'recording') recorder.current.stop(); stopTracks(); }, []);

  const start = useCallback(async () => {
    if (recorder.current && recorder.current.state !== 'inactive') return;
    setError(null);
    try {
      stream.current = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      const mimeType = pickMime();
      const rec = mimeType ? new MediaRecorder(stream.current, { mimeType }) : new MediaRecorder(stream.current);
      const chunks: Blob[] = [];
      rec.ondataavailable = (event) => { if (event.data.size > 0) chunks.push(event.data); };
      rec.onstop = async () => {
        stopTracks();
        recorder.current = null;
        if (gone.current) return;
        const type = rec.mimeType || 'audio/webm';
        const blob = new Blob(chunks, { type });
        if (blob.size < 800) { setState('idle'); setError('녹음이 너무 짧습니다'); return; }
        setState('transcribing');
        try {
          const ext = type.includes('mp4') ? 'm4a' : type.includes('ogg') ? 'ogg' : 'webm';
          const response = await transcribeVoice(blob, `recording.${ext}`);
          if (!response.ok) throw new Error(`실패했습니다 (${response.status})`);
          const body = await response.json() as { text?: string };
          const text = String(body.text ?? '').trim();
          if (text) onText(text); else setError('말소리를 알아듣지 못했습니다');
        } catch (err) {
          setError(`받아쓰지 못했습니다: ${err instanceof Error ? err.message : String(err)}`);
        } finally {
          if (!gone.current) setState('idle');
        }
      };
      recorder.current = rec;
      rec.start();
      setState('recording');
    } catch (err) {
      stopTracks();
      recorder.current = null;
      setState('idle');
      setError(err instanceof DOMException && err.name === 'NotAllowedError' ? '마이크 권한이 필요합니다' : '마이크를 쓸 수 없습니다');
    }
  }, [onText]);

  const stop = useCallback(() => { if (recorder.current?.state === 'recording') recorder.current.stop(); }, []);
  return { state, error, start, stop };
}
