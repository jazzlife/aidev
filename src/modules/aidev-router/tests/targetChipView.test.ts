import { describe, expect, it } from 'vitest';

import type { RouteResult } from '@/modules/aidev-router/api';
import { targetChipView } from '@/modules/aidev-router/hooks/useTargetChoice';

const options = [{ id: 1, name: 'mac-mini', platform: 'darwin', is_default: true }, { id: 2, name: 'win-box', platform: 'win32', is_default: false }];
const route = (target: { id: number; name: string; source: 'laya' | 'mention' | 'default' } | null, extra: Partial<RouteResult> = {}) => ({
  decision_id: 7,
  scope: { remote_action: target ? 'test' : 'none' },
  plan: { target: target ? { ...target, platform: null, tags: [], capabilities: null } : null, device: null },
  targets: options,
  ...extra,
}) as unknown as RouteResult;

describe('targetChipView (F-08 router chip)', () => {
  it('is hidden when no PC was online', () => {
    expect(targetChipView(null, undefined, null, undefined)).toBeNull();
    expect(targetChipView(route(null, { targets: [] }), undefined, null, undefined)).toBeNull();
  });
  it('shows the PC the last route used and how it was chosen', () => {
    const v = targetChipView(route({ id: 2, name: 'win-box', source: 'laya' }), undefined, null, undefined)!;
    expect([v.name, v.label, v.selectedId]).toEqual(['win-box', 'Laya 선택', null]);
    expect(targetChipView(route({ id: 2, name: 'win-box', source: 'mention' }), undefined, 1, undefined)!.selectedId).toBe(1);
  });
  it('a pick made since the route shows as applying from the next command', () => {
    const v = targetChipView(route({ id: 2, name: 'win-box', source: 'laya' }), 1, null, undefined)!;
    expect([v.name, v.label, v.selectedId]).toEqual(['mac-mini', '다음 명령부터', 1]);
    const auto = targetChipView(route({ id: 2, name: 'win-box', source: 'laya' }), null, 1, undefined)!;
    expect([auto.name, auto.selectedId]).toEqual([null, null]);
  });
  it('with no PC needed, shows the chat pin or automatic', () => {
    expect(targetChipView(route(null), undefined, 2, undefined)).toMatchObject({ name: 'win-box', label: '이 채팅 고정' });
    expect(targetChipView(route(null), undefined, null, 1)).toMatchObject({ name: 'mac-mini', label: '직접 선택' });
    expect(targetChipView(route(null), undefined, null, undefined)).toMatchObject({ name: null, label: '자동' });
  });
});
