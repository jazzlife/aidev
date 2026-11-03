import { Volume1, Volume2, VolumeX } from 'lucide-react';

import type { ScreenState } from '@/modules/remote-screen/session';

type SoundControls = { volume: number; muted: boolean; change: (next: { volume?: number; muted?: boolean }) => void };

/**
 * Used by the workbench ScreenPane and the mobile remote screen: the PC's sound while its screen streams — mute and a
 * volume slider (useRemoteScreen's `sound`). Without sound (this browser, an older runner) the button is off and says
 * why; while the browser holds the sound until a touch, pressing it lets it play.
 */
export function RemoteSoundControl({ state, sound, className = '' }: { state: ScreenState; sound: SoundControls; className?: string }) {
  const silent = sound.muted || sound.volume === 0;
  const Icon = silent ? VolumeX : sound.volume < 0.5 ? Volume1 : Volume2;
  const title = !state.audio ? state.audioNote ?? '소리 없음'
    : state.audioBlocked ? '눌러서 원격 PC의 소리 켜기 (브라우저가 클릭을 기다립니다)'
      : state.audioNote ?? (sound.muted ? '음소거 해제' : '음소거');
  return (
    <span className={`inline-flex items-center gap-1 ${className}`}>
      <button type="button" title={title} aria-label={title} aria-pressed={state.audio && sound.muted} disabled={!state.audio}
        onClick={() => sound.change(state.audioBlocked ? {} : { muted: !sound.muted })}
        className={`relative rounded p-1 disabled:opacity-40 ${state.audioBlocked || state.audioNote ? 'text-amber-600 dark:text-amber-400' : ''}`}>
        <Icon size={15} />
        {state.audio && state.audioBlocked ? <span className="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full bg-amber-500" /> : null}
      </button>
      <input type="range" min={0} max={100} step={1} aria-label="원격 PC 음량" title={`음량 ${Math.round(sound.volume * 100)}%`} disabled={!state.audio}
        value={sound.muted ? 0 : Math.round(sound.volume * 100)}
        onChange={(event) => { const volume = Number(event.target.value) / 100; sound.change({ volume, muted: volume === 0 }); }}
        className="h-1 w-20 cursor-pointer accent-current disabled:cursor-default disabled:opacity-40" />
    </span>
  );
}
