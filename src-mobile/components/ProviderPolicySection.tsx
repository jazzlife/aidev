import { EFFORT_LABEL, MODEL_LABEL, moveInOrder, SCORE_INDEX_LABEL, stepLabel, useProviderPolicy, type Engine, type ProviderPolicyEntry, type ProviderPolicyPatch, type ScoreIndex } from '@/modules/aidev-router';
import { ENGINE_LABELS } from '@/shared/constants';

const modelName = (model: string) => MODEL_LABEL[model] ?? model;
const selectClass = 'h-9 rounded-lg border border-line bg-elevated px-2 text-[14px]';
const chip = 'rounded-lg border border-line px-2.5 py-1 text-[13px] disabled:opacity-40';

/** Work or verification order: checked providers in order (↑↓ ✕), the others to add; none = automatic. */
function OrderRows({ title, hint, autoLabel, order, engines, disabled, onChange }: { title: string; hint: string; autoLabel: string; order: Engine[]; engines: Engine[]; disabled: boolean; onChange: (order: Engine[]) => void }) {
  const rest = engines.filter((engine) => !order.includes(engine));
  return (
    <div className="px-4 py-3">
      <div className="text-[15px]">{title}</div>
      <div className="text-[12px] text-muted">{hint}</div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {order.length === 0 ? <span className="rounded-lg border border-accent px-2.5 py-1 text-[13px] text-accent">{autoLabel}</span> : null}
        {order.map((engine, index) => (
          <span key={engine} className="flex items-center gap-1 rounded-lg border border-accent/60 px-2 py-1 text-[13px]">
            {index + 1}. {ENGINE_LABELS[engine] ?? engine}
            <button type="button" className={chip} disabled={disabled || index === 0} aria-label={`${engine} 위로`} onClick={() => onChange(moveInOrder(order, engine, -1))}>↑</button>
            <button type="button" className={chip} disabled={disabled} aria-label={`${engine} 빼기`} onClick={() => onChange(order.filter((e) => e !== engine))}>✕</button>
          </span>
        ))}
        {rest.map((engine) => <button key={engine} type="button" className={chip} disabled={disabled} onClick={() => onChange([...order, engine])}>+ {ENGINE_LABELS[engine] ?? engine}</button>)}
      </div>
    </div>
  );
}

/** One provider: tier table (floor + effort ceiling) or its range (ladder, model and effort floors/ceilings), with D0..D4. */
function ProviderRows({ engine, entry, disabled, onChange }: { engine: Engine; entry: ProviderPolicyEntry; disabled: boolean; onChange: (patch: Omit<ProviderPolicyPatch, 'engine'>) => void }) {
  // a provider without a tier table (OpenCode) always runs the split: over the model it starts on until a ladder is set
  const hasTable = entry.tier_table !== false;
  const split = hasTable ? entry.mode === 'split' : Boolean(entry.own_ladder);
  const ladder = entry.ladder ?? (hasTable ? entry.catalog.map((m) => m.model) : []);
  const excluded = entry.catalog.map((m) => m.model).filter((model) => !ladder.includes(model));
  const setLadder = (next: string[]) => onChange({ ladder: next, ...(entry.floor && !next.includes(entry.floor) ? { floor: null } : {}), ...(entry.ceiling && !next.includes(entry.ceiling) ? { ceiling: null } : {}) });
  const effortIndex = (effort: string | null) => (effort ? entry.effort_ladder.indexOf(effort) : -1);
  const floorIndex = entry.floor ? ladder.indexOf(entry.floor) : 0;
  const ceilingIndex = entry.ceiling ? ladder.indexOf(entry.ceiling) : ladder.length - 1;
  return (
    <div className="px-4 py-3" data-testid={`provider-policy-${engine}`}>
      <div className="flex items-center gap-2">
        <span className="text-[15px]">{ENGINE_LABELS[engine] ?? engine}</span>
        <span className="text-[12px] text-muted">{split ? '범위 분할' : hasTable ? '등급표(기본)' : '기본 모델'}</span>
        <span className="flex-1" />
        {split
          ? <button type="button" className="text-[13px] text-muted" disabled={disabled} onClick={() => onChange({ reset: true })}>{hasTable ? '등급표로' : '기본 모델로'}</button>
          : <button type="button" className="text-[13px] text-accent disabled:opacity-40" disabled={disabled || !ladder.length} onClick={() => onChange({ ladder })}>범위 설정</button>}
      </div>
      {split ? (
        <div className={`mt-2 flex flex-wrap gap-1.5 ${hasTable ? '' : 'max-h-48 overflow-y-auto'}`}>
          {ladder.map((model, index) => (
            <span key={model} className="flex items-center gap-1 rounded-lg border border-line px-2 py-1 text-[13px]">
              {modelName(model)}
              <button type="button" className={chip} disabled={disabled || index === 0} aria-label={`${model} 약하게`} onClick={() => setLadder(ladder.map((m, i) => (i === index - 1 ? model : i === index ? ladder[index - 1] : m)))}>↑</button>
              <button type="button" className={chip} disabled={disabled || ladder.length === 1} aria-label={`${model} 빼기`} onClick={() => setLadder(ladder.filter((m) => m !== model))}>✕</button>
            </span>
          ))}
          {excluded.map((model) => <button key={model} type="button" className={chip} disabled={disabled} onClick={() => setLadder([...ladder, model])}>+ {modelName(model)}</button>)}
        </div>
      ) : null}
      {!hasTable && !ladder.length ? <div className="mt-2 text-[12px] text-muted">OpenCode에 로그인하면 쓸 수 있는 모델이 여기에 나타납니다.</div> : null}
      <div className="mt-2 grid grid-cols-2 gap-2">
        {split || hasTable ? (
          <label className="flex flex-col gap-1"><span className="text-[12px] text-muted">모델 하한</span>
            <select className={selectClass} disabled={disabled} value={entry.floor ?? ''} aria-label={`${engine} 모델 하한`} onChange={(event) => onChange({ floor: event.target.value || null })}>
              <option value="">{split ? '사다리 처음' : '하한 없음'}</option>
              {ladder.slice(0, split ? ceilingIndex + 1 : ladder.length).map((model) => <option key={model} value={model}>{modelName(model)}</option>)}
            </select>
          </label>
        ) : null}
        {split ? (
          <label className="flex flex-col gap-1"><span className="text-[12px] text-muted">모델 상한</span>
            <select className={selectClass} disabled={disabled} value={entry.ceiling ?? ''} aria-label={`${engine} 모델 상한`} onChange={(event) => onChange({ ceiling: event.target.value || null })}>
              <option value="">사다리 끝</option>
              {ladder.slice(Math.max(0, floorIndex)).map((model) => <option key={model} value={model}>{modelName(model)}</option>)}
            </select>
          </label>
        ) : null}
        {split ? (
          <label className="flex flex-col gap-1"><span className="text-[12px] text-muted">강도 하한</span>
            <select className={selectClass} disabled={disabled} value={entry.effort_floor ?? ''} aria-label={`${engine} 강도 하한`} onChange={(event) => onChange({ effort_floor: event.target.value || null })}>
              <option value="">가장 낮은 강도</option>
              {entry.effort_ladder.filter((effort) => effortIndex(effort) <= effortIndex(entry.effort_cap)).map((effort) => <option key={effort} value={effort}>{EFFORT_LABEL[effort] ?? effort}</option>)}
            </select>
          </label>
        ) : null}
        <label className="flex flex-col gap-1"><span className="text-[12px] text-muted">강도 상한</span>
          <select className={selectClass} disabled={disabled} value={entry.effort_cap ?? ''} aria-label={`${engine} 강도 상한`} onChange={(event) => onChange({ effort_cap: event.target.value })}>
            {entry.effort_ladder.filter((effort) => !split || effortIndex(effort) >= effortIndex(entry.effort_floor)).map((effort) => <option key={effort} value={effort}>{EFFORT_LABEL[effort] ?? effort}</option>)}
          </select>
        </label>
      </div>
      <div className="mt-2 text-[12px] text-muted" data-testid={`provider-preview-${engine}`}>
        {entry.preview.map((step, depth) => <div key={depth}>D{depth} → {stepLabel(step, modelName)}{step?.score !== null && step?.score !== undefined ? ` · 점수 ${step.score}` : ''}</div>)}
      </div>
    </div>
  );
}

/**
 * Settings: the provider policy (shared hook with the workbench): work and verification orders, the score index and
 * each provider's range with what D0..D4 run at. Replaces the engine-priority choice and the account effort/floor
 * controls (a chat's own ceiling stays in the routing sheet).
 */
export function ProviderPolicySection() {
  const policy = useProviderPolicy();
  const view = policy.view;
  if (!view) return <div className="rounded-xl2 border border-line bg-surface px-4 py-3 text-[14px] text-muted">{policy.error ?? '불러오는 중…'}</div>;
  // the providers this account routes to (OpenCode once an administrator enabled it)
  const engines = (Object.keys(view.providers) as Engine[]).filter((engine) => view.providers[engine]?.allowed !== false);
  return (
    <div data-testid="provider-policy">
      <div className="rounded-xl2 border border-line bg-surface divide-y divide-line">
        <OrderRows title="작업 우선순위" hint="한도에 걸렸을 때만 다음 순위로 넘어가고, 풀리면 되돌아옵니다." autoLabel="자동 (학습 가중치)" order={view.work_priority} engines={engines} disabled={policy.saving} onChange={(order) => { void policy.setWorkPriority(order); }} />
        <OrderRows title="검증 우선순위" hint="끝난 작업(D2 이상)을 검증할 공급자 순서입니다." autoLabel="자동 (작업자와 다른 공급자)" order={view.verify_priority} engines={engines} disabled={policy.saving} onChange={(order) => { void policy.setVerifyPriority(order); }} />
        <label className="px-4 py-3 flex items-center gap-3">
          <span className="flex-1 text-[15px]">분할 기준 점수</span>
          <select className={selectClass} disabled={policy.saving} value={view.score_index} aria-label="분할 기준 점수" onChange={(event) => { void policy.setScoreIndex(event.target.value as ScoreIndex); }}>
            {(Object.keys(SCORE_INDEX_LABEL) as ScoreIndex[]).map((index) => <option key={index} value={index}>{SCORE_INDEX_LABEL[index]}</option>)}
          </select>
        </label>
        {engines.map((engine) => <ProviderRows key={engine} engine={engine} entry={view.providers[engine]!} disabled={policy.saving} onChange={(patch) => { void policy.setProvider({ engine, ...patch }); }} />)}
      </div>
      <div className="text-[12px] text-muted mt-2">
        {policy.error ?? '공급자 안에서는 정한 모델·강도 범위를 난이도 D0~D4에 맞춰 나눠 고르고, 상한 모델이 그 난이도에 못 미치면 상한 모델을 최대 강도로 씁니다.'}
        {' '}지능 점수: <a className="underline" href={view.scores_source.url} target="_blank" rel="noreferrer">{view.scores_source.name}</a>{view.scores_source.version ? ` v${view.scores_source.version}` : ''}
      </div>
    </div>
  );
}
