import type { ScreenState } from '@/modules/remote-screen/session';

/** Used by remote-target (ScreenPane) and the mobile remote screen: the stream's one-line status — codec, frame
 *  rate, data rate, (with 0.15+ runners) the estimated latency from capture to the screen and whether the frames come
 *  straight from the PC (0.18+ runners, WebRTC) or over the gateway's CDN-free address. */
export function streamStatusLine(state: ScreenState) {
  const latency = state.stats?.latencyMs;
  return [
    state.codec ?? '…',
    `${state.fps}fps`,
    `${(state.kbps / 1000).toFixed(1)}Mbps`,
    ...(typeof latency === 'number' ? [`지연 ~${latency}ms`] : []),
    ...(state.direct ? ['직접 연결'] : state.fastPath ? ['빠른 경로'] : []),
  ].join(' · ');
}

/** Used with streamStatusLine (its tooltip): where the time goes, stage by stage. */
export function streamStatsDetail(state: ScreenState) {
  const s = state.stats;
  if (!s) return '';
  const ms = (v: number | null) => (v === null ? '–' : `${v}`);
  return `캡처 ${ms(s.captureMs)} · 축소 ${ms(s.scaleMs)} · 인코딩 ${ms(s.encodeMs)} · 전송→표시→응답 ${ms(s.loopMs)} · 디코딩 ${ms(s.decodeMs)} ms · 비트레이트 ${s.bitrate}kbps${s.skipped ? ` · 밀려서 건너뜀 ${s.skipped}` : ''}`;
}
