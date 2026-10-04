import { api } from '@/modules/chat-core';

/**
 * What the composer suggests while typing (C-12.6): `/` commands — built-in, the provider's skills, the project's own —
 * most used first (the workbench's history key, per project), and `@` files of the project (gitignore respected), the
 * tree flattened like the workbench's mentions. Both load on the first `/` or `@` and are kept per project.
 */
export type SlashCommand = { name: string; description?: string; path?: string; type: 'built-in' | 'skill' | 'custom' };
export type MentionFile = { name: string; path: string };

const historyKey = (projectId: string) => `command_history_${projectId}`;

export function readCommandHistory(projectId: string): Record<string, number> {
  try { return JSON.parse(localStorage.getItem(historyKey(projectId)) ?? '{}') as Record<string, number>; } catch { return {}; }
}

export function trackCommandUse(projectId: string, name: string) {
  const history = readCommandHistory(projectId);
  history[name] = (history[name] ?? 0) + 1;
  try { localStorage.setItem(historyKey(projectId), JSON.stringify(history)); } catch { /* storage full or off */ }
}

const commandCache = new Map<string, Promise<SlashCommand[]>>();

export function loadCommands(project: { projectId: string; fullPath: string }, provider: string): Promise<SlashCommand[]> {
  const key = `${project.projectId}:${provider}`;
  let request = commandCache.get(key);
  if (!request) {
    request = (async () => {
      const response = await api.commands.list(project.fullPath || undefined);
      if (!response.ok) throw new Error(`명령 목록을 불러오지 못했습니다 (${response.status})`);
      const data = await response.json() as { builtIn?: SlashCommand[]; custom?: SlashCommand[] };
      // the provider's skills are extra: without them the commands still list
      let skills: Array<{ command: string; description?: string; sourcePath?: string }> = [];
      try {
        const skillsResponse = await api.providers.skills(provider, { workspacePath: project.fullPath });
        if (skillsResponse.ok) skills = ((await skillsResponse.json()) as { data?: { skills?: typeof skills } }).data?.skills ?? [];
      } catch { /* listed without skills */ }
      const seen = new Set<string>();
      const skillCommands = skills.filter((skill) => !seen.has(skill.command) && seen.add(skill.command))
        .map((skill): SlashCommand => ({ name: skill.command, description: skill.description, path: skill.sourcePath, type: 'skill' }));
      return [
        ...(data.builtIn ?? []).map((c): SlashCommand => ({ ...c, type: 'built-in' })),
        ...skillCommands,
        ...(data.custom ?? []).map((c): SlashCommand => ({ ...c, type: 'custom' })),
      ];
    })();
    request.catch(() => commandCache.delete(key));
    commandCache.set(key, request);
  }
  return request;
}

/** Names starting with the query first, then names or descriptions holding it; most used first within each. */
export function filterCommands(commands: SlashCommand[], query: string, history: Record<string, number>): SlashCommand[] {
  const q = query.toLowerCase();
  const byUse = (a: SlashCommand, b: SlashCommand) => (history[b.name] ?? 0) - (history[a.name] ?? 0);
  const prefix = commands.filter((c) => c.name.toLowerCase().startsWith(`/${q}`)).sort(byUse);
  const rest = q ? commands.filter((c) => !prefix.includes(c) && (c.name.toLowerCase().includes(q) || c.description?.toLowerCase().includes(q))).sort(byUse) : [];
  return [...prefix, ...rest];
}

type TreeNode = { name: string; type: string; path?: string; children?: TreeNode[] };

export function flattenFileTree(nodes: TreeNode[], base = ''): MentionFile[] {
  const out: MentionFile[] = [];
  for (const node of nodes) {
    const full = base ? `${base}/${node.name}` : node.name;
    if (node.type === 'directory' && node.children) out.push(...flattenFileTree(node.children, full));
    else if (node.type === 'file') out.push({ name: node.name, path: full });
  }
  return out;
}

const fileCache = new Map<string, Promise<MentionFile[]>>();

export function loadFiles(projectId: string): Promise<MentionFile[]> {
  let request = fileCache.get(projectId);
  if (!request) {
    request = api.getFiles(projectId).then(async (response) => {
      if (!response.ok) throw new Error(`파일 목록을 불러오지 못했습니다 (${response.status})`);
      const body = await response.json() as TreeNode[] | { files?: TreeNode[] };
      return flattenFileTree(Array.isArray(body) ? body : body.files ?? []);
    });
    request.catch(() => fileCache.delete(projectId));
    fileCache.set(projectId, request);
  }
  return request;
}

/** Fuzzy: the query's letters in order; a match in the name and an earlier, tighter match rank first. */
export function matchFiles(files: MentionFile[], query: string, limit = 10): MentionFile[] {
  const q = query.toLowerCase();
  if (!q) return files.slice(0, limit);
  const score = (text: string) => {
    const t = text.toLowerCase();
    const direct = t.indexOf(q);
    if (direct >= 0) return direct;
    let at = -1; let first = -1;
    for (const ch of q) { at = t.indexOf(ch, at + 1); if (at < 0) return null; if (first < 0) first = at; }
    return 1000 + (at - first);
  };
  return files
    .map((file) => {
      const inName = score(file.name);
      const inPath = score(file.path);
      const best = inName !== null ? inName : inPath !== null ? 500 + inPath : null;
      return { file, best };
    })
    .filter((entry): entry is { file: MentionFile; best: number } => entry.best !== null)
    .sort((a, b) => a.best - b.best || a.file.path.length - b.file.path.length)
    .slice(0, limit)
    .map((entry) => entry.file);
}

/** What the text before the cursor asks for: a command (`/que`, only at the start) or a file (`… @que`). */
export function assistQuery(text: string, cursor: number): { kind: 'command' | 'file'; query: string; start: number } | null {
  const before = text.slice(0, cursor);
  const command = /^\/(\S*)$/.exec(before);
  if (command) return { kind: 'command', query: command[1] ?? '', start: 0 };
  const mention = /(^|\s)@(\S*)$/.exec(before);
  if (mention) return { kind: 'file', query: mention[2] ?? '', start: before.length - (mention[2]?.length ?? 0) - 1 };
  return null;
}
