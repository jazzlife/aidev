import { callGateway, resolveTarget } from '@/modules/aidev-tools/aidev-tools.service.js';

/**
 * nadovibe_show / nadovibe_settings (2026-10-02): an agent drives NadoVibe itself for the user — opens a PC's live screen
 * (a program window or the whole screen), a preview, the debugger, PC pairing, settings, a project or an agent on the
 * user's open pages, and reads or changes the user's settings directly (the user chose "바로 변경": no confirmation; the
 * tool call in the chat is the record). Pages carry the commands out through the gateway's app-control queue.
 */
export const SHOW_VIEWS = ['screen', 'preview', 'debug', 'pcs', 'settings', 'project', 'catalog'] as const;
export type ShowInput = {
  view: string; target?: string | number; window?: string | number; port?: number; session?: string;
  section?: string; project?: string; agent?: string; note?: string;
};
type Turn = { targetId?: number | null; agent?: string | null };

export async function appShow(input: ShowInput, turn: Turn = {}) {
  const view = SHOW_VIEWS.find((v) => v === input.view);
  if (!view) throw new Error(`view: ${SHOW_VIEWS.join(' | ')}`);
  const params: Record<string, string | number | boolean | null> = {};
  let targetName: string | null = null;
  if (view === 'screen' || view === 'preview' || (view === 'debug' && input.target !== undefined)) {
    const target = await resolveTarget(input.target, turn.targetId ?? null);
    if (!target.online) throw new Error(`대상 ${target.name}이(가) 오프라인입니다`);
    params.target = target.id;
    targetName = target.name;
  }
  if (view === 'screen') params.window = input.window === undefined || input.window === null || input.window === '' ? 'full' : String(input.window);
  if (view === 'preview' && input.port) params.port = Number(input.port);
  if (view === 'debug' && input.session) params.session = String(input.session);
  if (view === 'settings' && input.section) params.section = String(input.section);
  if (view === 'project') {
    if (!input.project) throw new Error('project (프로젝트 id 또는 이름)가 필요합니다');
    params.project = String(input.project);
  }
  if (view === 'catalog' && input.agent) params.agent = String(input.agent);
  const r = await callGateway('POST', '/ui/commands', { action: 'show', view, params, note: input.note ?? null, agent: turn.agent ?? undefined }) as { viewers?: number; command?: { id: number } };
  const viewers = Number(r.viewers ?? 0);
  return {
    view, target: targetName, params, viewers,
    shown: viewers > 0,
    message: viewers > 0
      ? `사용자의 NadoVibe 화면 ${viewers}곳에 열었습니다.`
      : '지금 NadoVibe를 보고 있는 화면이 없습니다 — 사용자가 앱을 열면 보이지 않으니, 열어 달라고 말하세요.',
  };
}

type TargetRow = { id: number; name: string; online: boolean; policy: string; is_default?: number | boolean; platform: string | null;
  capabilities?: { runner?: string; screen?: boolean; control?: boolean; os?: string } | null };

/** What the agent can see and change. */
export async function appSettingsGet() {
  const [targets, engines] = await Promise.all([
    callGateway('GET', '/targets') as Promise<{ targets?: TargetRow[] }>,
    callGateway('GET', '/engines') as Promise<Record<string, unknown>>,
  ]);
  return {
    pcs: (targets.targets ?? []).map((t) => ({
      name: t.name, online: t.online, os: t.capabilities?.os ?? t.platform, runner: t.capabilities?.runner ?? null,
      policy: t.policy, default: Boolean(t.is_default), screen: Boolean(t.capabilities?.screen), control: Boolean(t.capabilities?.control),
    })),
    effort_cap: engines.effort_cap ?? null, effort_ladder: engines.effort_ladder ?? null,
    model_floor: engines.model_floor ?? null, model_ladder: engines.model_ladder ?? null,
    engine_priority: engines.engine_priority ?? null,
    engines: engines.engines ?? null, default_engine: engines.default_engine ?? null,
    keys: {
      'pc.policy': 'full | auto | ask | deny (target required)', 'pc.default': 'true | false (target required)',
      'pc.screen': 'true | false — screen capture on that PC (target required)', 'pc.control': 'true | false — remote mouse/keyboard (target required; implies screen)',
      'effort_cap.claude': 'an effort from effort_ladder.claude, or "" for none', 'effort_cap.codex': 'an effort from effort_ladder.codex, or "" for none',
      'model_floor.claude': 'a model from model_ladder.claude — routing never picks a weaker one; "" for none', 'model_floor.codex': 'a model from model_ladder.codex, or "" for none',
      engine_priority: '"claude,codex" | "codex,claude" | "" (learned weights) — the order engines are used in; a limited engine is skipped and the chat moves back when it is usable again',
      routing_mode: 'auto | manual | off — applied by the user\'s open pages',
    },
  };
}

const bool = (v: unknown) => {
  if (typeof v === 'boolean') return v;
  if (v === 'true' || v === 'on' || v === 1 || v === '1') return true;
  if (v === 'false' || v === 'off' || v === 0 || v === '0') return false;
  throw new Error('true | false');
};

/** Changes one setting at once and returns what it is now. */
export async function appSettingsSet(input: { key: string; value: unknown; target?: string | number }, turn: Turn = {}) {
  const key = input.key;
  if (key.startsWith('pc.')) {
    const target = await resolveTarget(input.target, turn.targetId ?? null);
    if (key === 'pc.policy') {
      const policy = String(input.value);
      if (!['full', 'auto', 'ask', 'deny'].includes(policy)) throw new Error('pc.policy: full | auto | ask | deny');
      await callGateway('PATCH', `/targets/${target.id}`, { policy });
      return { key, target: target.name, value: policy };
    }
    if (key === 'pc.default') {
      await callGateway('PATCH', `/targets/${target.id}`, { default: bool(input.value) });
      return { key, target: target.name, value: bool(input.value) };
    }
    if (key === 'pc.screen' || key === 'pc.control') {
      if (!target.online) throw new Error(`대상 ${target.name}이(가) 오프라인입니다 — 러너가 실행 중이어야 바꿀 수 있습니다`);
      const r = await callGateway('POST', `/targets/${target.id}/consent`, { [key === 'pc.screen' ? 'screen' : 'control']: bool(input.value) }) as { consent?: { screen: boolean; control: boolean }; error?: string };
      if (!r.consent) throw new Error(String(r.error ?? '바꾸지 못했습니다'));
      return { key, target: target.name, value: key === 'pc.screen' ? r.consent.screen : r.consent.control, now: r.consent };
    }
    throw new Error(`알 수 없는 설정: ${key}`);
  }
  if (key === 'effort_cap.claude' || key === 'effort_cap.codex') {
    const engine = key.slice('effort_cap.'.length);
    const r = await callGateway('PUT', '/settings/effort-cap', { [engine]: String(input.value ?? '') }) as { effort_cap?: unknown };
    return { key, value: input.value, effort_cap: r.effort_cap ?? null };
  }
  if (key === 'model_floor.claude' || key === 'model_floor.codex') {
    const engine = key.slice('model_floor.'.length);
    const r = await callGateway('PUT', '/settings/model-floor', { [engine]: String(input.value ?? '') }) as { model_floor?: unknown };
    return { key, value: input.value, model_floor: r.model_floor ?? null };
  }
  if (key === 'engine_priority') {
    const order = String(input.value ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    const r = await callGateway('PUT', '/settings/engine-priority', { order: order.length ? order : null }) as { engine_priority?: unknown };
    return { key, value: r.engine_priority ?? null };
  }
  if (key === 'routing_mode') {
    const mode = String(input.value);
    if (!['auto', 'manual', 'off'].includes(mode)) throw new Error('routing_mode: auto | manual | off');
    const r = await callGateway('POST', '/ui/commands', { action: 'set', params: { key, value: mode }, agent: turn.agent ?? undefined }) as { viewers?: number };
    return { key, value: mode, applied_on_pages: Number(r.viewers ?? 0), note: '라우팅 모드는 각 기기(브라우저)에 저장됩니다 — 지금 열린 화면에 적용했습니다' };
  }
  throw new Error(`알 수 없는 설정: ${key} — nadovibe_settings{action:"get"}의 keys를 보세요`);
}
