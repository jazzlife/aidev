import { PRIORITY_CHOICES, priorityKey, useEnginePriority } from '@/modules/aidev-router/hooks/useEnginePriority';

/** Used by the workbench Settings → Agents tab: the order engines are used in, above the effort and model defaults. */
export function EnginePriorityDefaults() {
  const priority = useEnginePriority();
  const current = priorityKey(priority.order);
  return (
    <section className="rounded-lg border border-border p-3 text-sm" data-testid="engine-priority-defaults">
      <div className="font-medium">엔진 우선순위</div>
      <div className="mt-0.5 text-xs text-muted-foreground">새 채팅은 우선 엔진으로 시작합니다. 한도나 로그아웃으로 쓸 수 없으면 다음 엔진이 대신 맡고, 다시 쓸 수 있게 되면 다음 메시지부터 우선 엔진으로 되돌아갑니다. 채팅에서 엔진을 직접 고정한 경우만 예외입니다.</div>
      {priority.order === null ? <div className="mt-2 text-xs text-muted-foreground">불러오는 중…</div> : (
        <div className="mt-2 flex flex-wrap gap-2">
          {PRIORITY_CHOICES.map((choice) => (
            <button key={choice.key} type="button" aria-pressed={current === choice.key} title={choice.hint} onClick={() => { void priority.save(choice.order); }}
              className={`rounded-md border px-3 py-1.5 text-xs ${current === choice.key ? 'border-primary bg-primary/10 font-medium' : 'border-border hover:bg-accent'}`}>
              {choice.label}
            </button>
          ))}
        </div>
      )}
      {priority.order !== null ? <div className="mt-1 text-xs text-muted-foreground">{PRIORITY_CHOICES.find((choice) => choice.key === current)?.hint}</div> : null}
      {priority.error ? <div className="mt-1 text-xs text-red-600">{priority.error}</div> : null}
    </section>
  );
}
