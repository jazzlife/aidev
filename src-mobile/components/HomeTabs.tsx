import { useGo } from '@m/lib/nav';

/** Used by the two home screens as their title: "프로젝트 · 대화" (C-12.1). The root `/` stays the conversation list. */
export function HomeTabs({ active }: { active: 'conversations' | 'projects' }) {
  const go = useGo();
  const tab = (key: 'conversations' | 'projects', label: string, path: string) => (
    <button
      type="button"
      role="tab"
      aria-selected={active === key}
      onClick={() => { if (active !== key) go(path); }}
      className={`m-touch px-3 rounded-full text-[15px] ${active === key ? 'font-semibold text-ink bg-elevated' : 'text-muted'}`}
    >
      {label}
    </button>
  );
  return <div role="tablist" className="flex items-center gap-1">{tab('projects', '프로젝트', '/projects')}{tab('conversations', '대화', '/')}</div>;
}
