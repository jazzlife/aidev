import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { LazyCodeEditor } from '@/modules/code-editor/LazyCodeEditor';

/**
 * 2026-11-09: an image opened in the right pane showed nothing for a long while — the pane waited, blank, for the
 * CodeMirror bundle (Suspense fallback null) and only then started downloading the image. A media file now opens in
 * the preview at once, and a text file shows the loading state while the editor bundle downloads.
 */
const reads = vi.hoisted(() => ({ paths: [] as string[] }));
vi.mock('@/shared/api', () => ({
  api: { readFileBlob: (_projectId: string, path: string) => { reads.paths.push(path); return new Promise(() => undefined); } },
}));
vi.mock('@/shared/context/ThemeContext', () => ({ useTheme: () => ({ isDarkMode: false }) }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string, fallback?: unknown) => (typeof fallback === 'string' ? fallback : key) }) }));
// the editor bundle never arrives in these tests: whatever shows meanwhile is what the user sees on a slow link
vi.mock('@/modules/code-editor/CodeEditor', () => new Promise(() => undefined));

beforeEach(() => { reads.paths = []; });

describe('the right pane opening a file', () => {
  it('an image starts downloading in the preview at once, with a loading indicator, without the editor bundle', () => {
    render(<LazyCodeEditor file={{ name: 'shot.png', path: 'docs/shot.png', projectId: 'p1' }} onClose={() => undefined} isSidebar />);
    expect(screen.getByTestId('media-preview-loading')).toBeTruthy();
    expect(reads.paths).toEqual(['docs/shot.png']);
  });

  it('a text file shows the loading state, not a blank pane, while the editor bundle downloads', () => {
    const { container } = render(<LazyCodeEditor file={{ name: 'main.ts', path: 'src/main.ts', projectId: 'p1' }} onClose={() => undefined} isSidebar />);
    expect(container.textContent).toContain('loading');
    expect(container.querySelector('.animate-spin')).toBeTruthy();
  });
});
