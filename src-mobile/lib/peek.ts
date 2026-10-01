import { parseToolPayload } from '@/modules/chat-core';

/**
 * Pure helpers behind the chat's file and diff peeks (IMPLEMENTATION-PLAN §3.11): which inline code is a
 * file reference, what a file tool changed, and which highlighter language a file uses.
 */
export type FileRef = { path: string; line: number | null };

// a bare name (`README.md`) is a file only with an extension people actually open; paths and `:line` always are
const CODE_EXTENSIONS = new Set(['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'json', 'md', 'css', 'scss', 'html', 'vue', 'svelte', 'py', 'rs', 'go', 'java', 'kt', 'swift', 'c', 'cc', 'cpp', 'h', 'hpp', 'cs', 'rb', 'php', 'sh', 'yml', 'yaml', 'toml', 'sql', 'xml', 'gradle', 'txt', 'env']);
const FILE_REF = /^((?:\/|~\/|\.{1,2}\/)?(?:[\w.@+-]+\/)*[\w.@+-]*\.([A-Za-z][A-Za-z0-9]{0,7}))(?::(\d+)(?::\d+)?)?$/;

/** Used by the chat transcript: `src/app.ts:12` (inline code) → a file reference the peek can open, or null. */
export function fileRefFromText(text: string): FileRef | null {
  const match = FILE_REF.exec(text.trim());
  if (!match) return null;
  const [, path, extension, line] = match;
  if (!path.includes('/') && !line && !CODE_EXTENSIONS.has(extension.toLowerCase())) return null;
  return { path, line: line ? Number(line) : null };
}

export type FileEdit = { path: string; hunks: Array<{ before: string; after: string }>; created: boolean; deleted: boolean };

const str = (value: unknown) => (typeof value === 'string' ? value : '');

/**
 * Used by the tool cards: what a file tool call changed. Claude's Edit/MultiEdit/Write/ApplyPatch and Codex
 * file changes (normalized to Edit/Write with old_string/new_string) all land here; other tools → null.
 */
export function fileEditFromTool(toolName: string | undefined, input: unknown): FileEdit | null {
  const record = parseToolPayload(input);
  if (!record || typeof record !== 'object') return null;
  const fields = record as Record<string, unknown>;
  const path = str(fields.file_path) || str(fields.path);
  if (!path) return null;
  if (toolName === 'Edit' || toolName === 'ApplyPatch') {
    return { path, hunks: [{ before: str(fields.old_string), after: str(fields.new_string) }], created: false, deleted: fields.deleted === true };
  }
  if (toolName === 'MultiEdit' && Array.isArray(fields.edits)) {
    const hunks = fields.edits.map((edit) => { const e = (edit ?? {}) as Record<string, unknown>; return { before: str(e.old_string), after: str(e.new_string) }; });
    return { path, hunks, created: false, deleted: false };
  }
  if (toolName === 'Write') {
    return { path, hunks: [{ before: '', after: str(fields.content) || str(fields.new_string) }], created: true, deleted: false };
  }
  return null;
}

/** Used by the tool cards: the file a read-only file tool looked at (Read), so it can be peeked too. */
export function filePathFromTool(toolName: string | undefined, input: unknown): string | null {
  if (toolName !== 'Read') return null;
  const record = parseToolPayload(input);
  if (!record || typeof record !== 'object') return null;
  return str((record as Record<string, unknown>).file_path) || null;
}

// the eight highlight.js grammars the mobile app ships (§3.11); everything else is shown as plain text
const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  json: 'json', html: 'xml', htm: 'xml', xml: 'xml', svg: 'xml', vue: 'xml',
  css: 'css', scss: 'css', py: 'python', sh: 'bash', bash: 'bash', zsh: 'bash', yml: 'yaml', yaml: 'yaml',
};

/** Used by FilePeek: the highlight.js language for a path, or null for plain text. */
export function languageFor(path: string): string | null {
  const extension = /\.([A-Za-z0-9]+)$/.exec(path)?.[1]?.toLowerCase();
  return extension ? LANGUAGE_BY_EXTENSION[extension] ?? null : null;
}
