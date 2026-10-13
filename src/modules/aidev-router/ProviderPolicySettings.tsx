import type { Engine, ProviderPolicyEntry, ScoreIndex } from '@/modules/aidev-router/api';
import { EFFORT_LABEL } from '@/modules/aidev-router/hooks/useEffortCap';
import { MODEL_LABEL } from '@/modules/aidev-router/hooks/useModelFloor';
import { moveInOrder, SCORE_INDEX_LABEL, stepLabel, useProviderPolicy } from '@/modules/aidev-router/hooks/useProviderPolicy';
import { ENGINE_LABELS } from '@/shared/constants';

const modelName = (model: string) => MODEL_LABEL[model] ?? model;
const selectClass = 'h-8 rounded border border-border bg-background px-2 text-xs';
const smallButton = 'rounded border border-border px-2 py-0.5 text-xs hover:bg-accent disabled:opacity-40';

/** An ordered choice of providers: checked ones in order (↑↓), unchecked after; none checked = automatic. */
function OrderEditor({ label, hint, autoLabel, order, engines, disabled, onChange }: { label: string; hint: string; autoLabel: string; order: Engine[]; engines: Engine[]; disabled: boolean; onChange: (order: Engine[]) => void }) {
  const rest = engines.filter((engine) => !order.includes(engine));
  return (
    <div className="mt-3">
      <div className="text-xs font-medium">{label}</div>
      <div className="mt-0.5 text-xs text-muted-foreground">{hint}</div>
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        {order.length === 0 ? <span className="rounded-md border border-primary bg-primary/10 px-2 py-1 text-xs font-medium">{autoLabel}</span> : null}
        {order.map((engine, index) => (
          <span key={engine} className="flex items-center gap-1 rounded-md border border-primary/60 bg-primary/5 px-2 py-1 text-xs">
            <span className="font-medium">{index + 1}. {ENGINE_LABELS[engine] ?? engine}</span>
            <button type="button" className={smallButton} disabled={disabled || index === 0} aria-label={`${engine} 위로`} onClick={() => onChange(moveInOrder(order, engine, -1))}>↑</button>
            <button type="button" className={smallButton} disabled={disabled || index === order.length - 1} aria-label={`${engine} 아래로`} onClick={() => onChange(moveInOrder(order, engine, 1))}>↓</button>
            <button type="button" className={smallButton} disabled={disabled} aria-label={`${engine} 빼기`} onClick={() => onChange(order.filter((e) => e !== engine))}>✕</button>
          </span>
        ))}
        {rest.map((engine) => (
          <button key={engine} type="button" className={smallButton} disabled={disabled} onClick={() => onChange([...order, engine])}>+ {ENGINE_LABELS[engine] ?? engine}</button>
        ))}
      </div>
    </div>
  );
}

/** One provider's range: the tier table, or the split over its model and effort floors/ceilings, with the D0..D4 preview. */
function ProviderCard({ engine, entry, disabled, onChange }: { engine: Engine; entry: ProviderPolicyEntry; disabled: boolean; onChange: (patch: Omit<Parameters<ReturnType<typeof useProviderPolicy>['setProvider']>[0], 'engine'>) => void }) {
  // A provider with a tier table (Claude, Codex) runs the table until the user sets a range. One without (OpenCode)
  // always runs the split — over the model it starts on until the user sets a ladder of its own models.
  const hasTable = entry.tier_table !== false;
  const split = hasTable ? entry.mode === 'split' : Boolean(entry.own_ladder);
  const ladder = entry.ladder ?? (hasTable ? entry.catalog.map((m) => m.model) : []);
  const excluded = entry.catalog.map((m) => m.model).filter((model) => !ladder.includes(model));
  // a ladder change keeps the floor and ceiling only when they are still on it
  const setLadder = (next: string[]) => onChange({ ladder: next, ...(entry.floor && !next.includes(entry.floor) ? { floor: null } : {}), ...(entry.ceiling && !next.includes(entry.ceiling) ? { ceiling: null } : {}) });
  const floorIndex = entry.floor ? ladder.indexOf(entry.floor) : 0;
  const ceilingIndex = entry.ceiling ? ladder.indexOf(entry.ceiling) : ladder.length - 1;
  const effortIndex = (effort: string | null) => (effort ? entry.effort_ladder.indexOf(effort) : -1);
  const scored = entry.catalog.some((m) => m.scores.some((s) => s.score !== null));
  return (
    <div className="rounded-md border border-border p-2.5" data-testid={`provider-policy-${engine}`}>
      <div className="flex items-center gap-2">
        <span className="font-medium">{ENGINE_LABELS[engine] ?? engine}</span>
        <span className={`rounded px-1.5 py-0.5 text-[11px] ${split ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground'}`}>{split ? '범위 분할' : hasTable ? '등급표(기본)' : '기본 모델'}</span>
        <span className="flex-1" />
        {split
          ? <button type="button" className={smallButton} disabled={disabled} onClick={() => onChange({ reset: true })}>{hasTable ? '등급표로 되돌리기' : '기본 모델로 되돌리기'}</button>
          : <button type="button" className={smallButton} disabled={disabled || !ladder.length} onClick={() => onChange({ ladder })}>범위 설정</button>}
      </div>
      {split ? (
        <>
          <div className="mt-2 text-xs text-muted-foreground">모델 사다리 (약 → 강, 체크한 모델만 사용)</div>
          <div className="mt-1 flex flex-col gap-1">
            {ladder.map((model, index) => (
              <div key={model} className="flex items-center gap-1.5 text-xs">
                <input type="checkbox" checked disabled={disabled || ladder.length === 1} aria-label={`${model} 사용`} onChange={() => setLadder(ladder.filter((m) => m !== model))} />
                <span className="flex-1">{modelName(model)}</span>
                <button type="button" className={smallButton} disabled={disabled || index === 0} aria-label={`${model} 약하게`} onClick={() => setLadder(ladder.map((m, i) => (i === index - 1 ? model : i === index ? ladder[index - 1] : m)))}>↑</button>
                <button type="button" className={smallButton} disabled={disabled || index === ladder.length - 1} aria-label={`${model} 강하게`} onClick={() => setLadder(ladder.map((m, i) => (i === index + 1 ? model : i === index ? ladder[index + 1] : m)))}>↓</button>
              </div>
            ))}
            {/* OpenCode lists every model its sign-ins reach: the unused ones scroll */}
            <div className={hasTable ? 'flex flex-col gap-1' : 'flex max-h-40 flex-col gap-1 overflow-y-auto'}>
              {excluded.map((model) => (
                <div key={model} className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <input type="checkbox" checked={false} disabled={disabled} aria-label={`${model} 사용`} onChange={() => setLadder([...ladder, model])} />
                  <span>{modelName(model)}</span>
                </div>
              ))}
            </div>
          </div>
          <div className="mt-2 grid grid-cols-2 gap-2">
            <label className="flex flex-col gap-1 text-xs"><span className="text-muted-foreground">모델 하한</span>
              <select className={selectClass} disabled={disabled} value={entry.floor ?? ''} aria-label={`${engine} 모델 하한`} onChange={(event) => onChange({ floor: event.target.value || null })}>
                <option value="">사다리 처음</option>
                {ladder.slice(0, ceilingIndex + 1).map((model) => <option key={model} value={model}>{modelName(model)}</option>)}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-xs"><span className="text-muted-foreground">모델 상한</span>
              <select className={selectClass} disabled={disabled} value={entry.ceiling ?? ''} aria-label={`${engine} 모델 상한`} onChange={(event) => onChange({ ceiling: event.target.value || null })}>
                <option value="">사다리 끝</option>
                {ladder.slice(Math.max(0, floorIndex)).map((model) => <option key={model} value={model}>{modelName(model)}</option>)}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-xs"><span className="text-muted-foreground">강도 하한</span>
              <select className={selectClass} disabled={disabled} value={entry.effort_floor ?? ''} aria-label={`${engine} 강도 하한`} onChange={(event) => onChange({ effort_floor: event.target.value || null })}>
                <option value="">모델의 가장 낮은 강도</option>
                {entry.effort_ladder.filter((effort) => effortIndex(effort) <= effortIndex(entry.effort_cap)).map((effort) => <option key={effort} value={effort}>{effort} · {EFFORT_LABEL[effort] ?? effort}</option>)}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-xs"><span className="text-muted-foreground">강도 상한</span>
              <select className={selectClass} disabled={disabled} value={entry.effort_cap ?? ''} aria-label={`${engine} 강도 상한`} onChange={(event) => onChange({ effort_cap: event.target.value })}>
                {entry.effort_ladder.filter((effort) => effortIndex(effort) >= effortIndex(entry.effort_floor)).map((effort) => <option key={effort} value={effort}>{effort} · {EFFORT_LABEL[effort] ?? effort}</option>)}
              </select>
            </label>
          </div>
        </>
      ) : !hasTable && !ladder.length ? (
        <div className="mt-2 text-xs text-muted-foreground">OpenCode에 로그인하면 쓸 수 있는 모델이 여기에 나타납니다. 그 전에는 OpenCode가 스스로 고른 모델로 실행합니다.</div>
      ) : (
        <div className="mt-2 grid grid-cols-2 gap-2">
          {hasTable ? (
            <label className="flex flex-col gap-1 text-xs"><span className="text-muted-foreground">모델 하한</span>
              <select className={selectClass} disabled={disabled} value={entry.floor ?? ''} aria-label={`${engine} 기본 모델 하한`} onChange={(event) => onChange({ floor: event.target.value || null })}>
                <option value="">하한 없음 (판정대로)</option>
                {ladder.map((model) => <option key={model} value={model}>{modelName(model)}</option>)}
              </select>
            </label>
          ) : (
            <div className="flex flex-col gap-1 text-xs"><span className="text-muted-foreground">모델</span><span className="flex h-8 items-center">{modelName(ladder[0])}</span></div>
          )}
          <label className="flex flex-col gap-1 text-xs"><span className="text-muted-foreground">강도 상한</span>
            <select className={selectClass} disabled={disabled} value={entry.effort_cap ?? ''} aria-label={`${engine} 기본 effort 상한`} onChange={(event) => onChange({ effort_cap: event.target.value })}>
              {entry.effort_ladder.map((effort) => <option key={effort} value={effort}>{effort} · {EFFORT_LABEL[effort] ?? effort}</option>)}
            </select>
          </label>
        </div>
      )}
      <div className="mt-2 text-xs text-muted-foreground">난이도별 실행 {split || !hasTable ? (scored ? '(지능 점수로 분할)' : '(점수가 없어 칸 수로 분할)') : '(등급표)'}</div>
      <div className="mt-1 grid grid-cols-1 gap-0.5 text-xs" data-testid={`provider-preview-${engine}`}>
        {entry.preview.map((step, depth) => (
          <div key={depth} className="flex gap-2"><span className="w-6 text-muted-foreground">D{depth}</span><span>{stepLabel(step, modelName)}</span>{step?.score !== null && step?.score !== undefined ? <span className="text-muted-foreground">점수 {step.score}</span> : null}</div>
        ))}
      </div>
      {split ? (
        <details className="mt-2 text-xs">
          <summary className="cursor-pointer text-muted-foreground">조합별 지능 점수</summary>
          <div className="mt-1 space-y-0.5">
            {entry.catalog.filter((m) => hasTable || ladder.includes(m.model)).map((m) => (
              <div key={m.model} className="flex flex-wrap gap-x-2"><span className={hasTable ? 'w-28 shrink-0' : 'shrink-0'}>{modelName(m.model)}</span>
                {m.scores.map((s) => <span key={s.effort ?? '-'} className={s.estimated ? 'italic text-muted-foreground' : ''}>{s.effort ?? '기본'} {s.score ?? '–'}{s.estimated ? '(추정)' : ''}</span>)}
              </div>
            ))}
          </div>
        </details>
      ) : null}
    </div>
  );
}

/**
 * Used by the workbench Settings → Agents tab (settings module), above the per-provider tabs: what spans the providers —
 * the work and verification orders and the score index. Each provider's own range is its "모델·강도 범위" tab
 * (ProviderPolicyCard). Replaces the earlier engine-priority and effort/model-floor sections.
 */
export function ProviderPolicySettings() {
  const policy = useProviderPolicy();
  const view = policy.view;
  // the orders offer the providers this account routes to (OpenCode once an administrator enabled it)
  const engines = view ? (Object.keys(view.providers) as Engine[]).filter((engine) => view.providers[engine]?.allowed !== false) : [];
  return (
    <section className="rounded-lg border border-border p-3 text-sm" data-testid="provider-policy">
      <div className="font-medium">공급자 정책</div>
      <div className="mt-0.5 text-xs text-muted-foreground">작업은 작업 우선순위의 첫 공급자가 맡고, 사용량 한도에 걸렸을 때만 다음 순위로 넘어갑니다(한도가 풀리면 되돌아옴). 공급자마다 쓸 모델·강도의 범위는 아래 공급자별 설정의 「모델·강도 범위」 탭에서 정합니다.</div>
      {!view ? <div className="mt-2 text-xs text-muted-foreground">{policy.error ?? '불러오는 중…'}</div> : (
        <>
          <OrderEditor label="작업 우선순위" hint="새 채팅과 작업을 맡을 공급자 순서입니다. 채팅에서 엔진을 직접 고정한 경우만 예외입니다." autoLabel="자동 (작업 종류별 학습 가중치)"
            order={view.work_priority} engines={engines} disabled={policy.saving} onChange={(order) => { void policy.setWorkPriority(order); }} />
          <OrderEditor label="검증 우선순위" hint="끝난 작업(D2 이상)을 독립 검증할 공급자 순서입니다." autoLabel="자동 (작업자와 다른 공급자 우선)"
            order={view.verify_priority} engines={engines} disabled={policy.saving} onChange={(order) => { void policy.setVerifyPriority(order); }} />
          <label className="mt-3 flex items-center gap-2 text-xs">
            <span className="font-medium">분할 기준 점수</span>
            <select className={selectClass} disabled={policy.saving} value={view.score_index} aria-label="분할 기준 점수" onChange={(event) => { void policy.setScoreIndex(event.target.value as ScoreIndex); }}>
              {(Object.keys(SCORE_INDEX_LABEL) as ScoreIndex[]).map((index) => <option key={index} value={index}>{SCORE_INDEX_LABEL[index]}</option>)}
            </select>
            <span className="text-muted-foreground">출처: <a className="underline" href={view.scores_source.url} target="_blank" rel="noreferrer">{view.scores_source.name}</a>{view.scores_source.version ? ` · Index v${view.scores_source.version}` : ''}{view.scores_source.synced_at ? ` · ${new Date(view.scores_source.synced_at).toLocaleDateString('ko-KR')} 갱신` : ' · 아직 동기화 전'}</span>
          </label>
        </>
      )}
      {view && policy.error ? <div className="mt-1 text-xs text-red-600">{policy.error}</div> : null}
    </section>
  );
}

/**
 * Used by the workbench Settings → Agents tab (settings module) as the selected provider's "모델·강도 범위" category:
 * that provider's ladder, model and effort floors/ceilings and what D0..D4 run at (the gateway's preview).
 */
export function ProviderPolicyCard({ engine }: { engine: Engine }) {
  const policy = useProviderPolicy();
  const entry = policy.view?.providers[engine];
  return (
    <section className="space-y-2 text-sm" data-testid="provider-policy-card">
      <div className="text-xs text-muted-foreground">이 공급자 안에서 쓸 모델과 추론 강도의 범위입니다. 「범위 설정」을 누르면 정한 범위를 명령 난이도 D0~D4에 맞춰 나눠 고르고(지능 점수가 있으면 점수로), 상한 모델이 그 난이도에 못 미치면 상한 모델을 최대 강도로 씁니다. 높을수록 구독 사용량이 많이 듭니다.</div>
      {entry?.allowed === false ? <div className="rounded-md border border-border p-2.5 text-xs text-muted-foreground">이 계정은 아직 {ENGINE_LABELS[engine]}(으)로 작업을 보내도록 켜져 있지 않습니다. 관리자가 켜면 작업·검증 우선순위에 넣을 수 있고, 아래 범위가 적용됩니다. 그 전에도 {ENGINE_LABELS[engine]} 채팅을 직접 열어 쓰는 것은 됩니다.</div> : null}
      {entry ? <ProviderCard engine={engine} entry={entry} disabled={policy.saving} onChange={(patch) => { void policy.setProvider({ engine, ...patch }); }} />
        : <div className="text-xs text-muted-foreground">{policy.error ?? '불러오는 중…'}</div>}
      {entry && policy.error ? <div className="text-xs text-red-600">{policy.error}</div> : null}
    </section>
  );
}
