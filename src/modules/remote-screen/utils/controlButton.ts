import type { ScreenState } from '@/modules/remote-screen/session';

/** What the control button does: control on/off here, or (someone else holds it) ask, withdraw, or take it back. */
export type ControlOp = 'on' | 'off' | 'request' | 'cancel' | 'take';

/** Used by remote-target (ScreenPane) and the mobile remote screen: the control button for this viewer now — one
 *  person controls a PC at a time; the others ask, and the PC's owner may take it back (2026-10-11). */
export function controlButton(state: ScreenState): { label: string; op: ControlOp; active: boolean; hint: string | null } {
  if (state.control) return { label: '제어 중', op: 'off', active: true, hint: null };
  const holder = state.holder;
  // free, or held by this account on another screen (it moves here at once)
  if (!holder || holder.me || holder.mine) return { label: holder ? '여기서 제어' : '제어', op: 'on', active: false, hint: holder ? '같은 계정의 다른 화면에서 제어 중 — 누르면 이 화면으로 옮겨 옵니다' : null };
  if (state.owner) return { label: '제어권 회수', op: 'take', active: false, hint: `${holder.name} 님이 제어 중 — 소유자는 바로 가져올 수 있습니다` };
  if (state.requests.some((r) => r.me)) return { label: '요청 취소', op: 'cancel', active: false, hint: `${holder.name} 님에게 제어권을 요청했습니다 — 넘겨주거나 제어를 끝내면 받습니다` };
  return { label: '제어권 요청', op: 'request', active: false, hint: `${holder.name} 님이 제어 중` };
}
