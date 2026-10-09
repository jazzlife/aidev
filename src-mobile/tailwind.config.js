/** Mobile app design tokens live in theme/tokens.css; this config only scopes Tailwind to the mobile tree
 *  and the shared modules it imports — all non-visual, except the usage-limit panel, which draws with the
 *  mobile tokens in its compact variant and so is scanned here too. */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export default {
  darkMode: ['media'],
  content: [path.join(here, 'index.html'), path.join(here, '{screens,components,lib}/**/*.{ts,tsx}'), path.join(here, 'App.tsx'), path.join(here, '..', 'src/modules/aidev-router/UsageLimitPanel.tsx')],
  theme: {
    extend: {
      fontFamily: { sans: ['-apple-system', 'BlinkMacSystemFont', '"Segoe UI"', 'Roboto', '"Noto Sans KR"', 'sans-serif'], mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'] },
      colors: {
        bg: 'rgb(var(--m-bg) / <alpha-value>)',
        surface: 'rgb(var(--m-surface) / <alpha-value>)',
        elevated: 'rgb(var(--m-elevated) / <alpha-value>)',
        line: 'rgb(var(--m-line) / <alpha-value>)',
        ink: 'rgb(var(--m-ink) / <alpha-value>)',
        muted: 'rgb(var(--m-muted) / <alpha-value>)',
        accent: 'rgb(var(--m-accent) / <alpha-value>)',
        'accent-ink': 'rgb(var(--m-accent-ink) / <alpha-value>)',
        ok: 'rgb(var(--m-ok) / <alpha-value>)',
        warn: 'rgb(var(--m-warn) / <alpha-value>)',
        danger: 'rgb(var(--m-danger) / <alpha-value>)',
      },
      borderRadius: { xl2: '1.25rem' },
      spacing: { 'safe-b': 'env(safe-area-inset-bottom)', 'safe-t': 'env(safe-area-inset-top)' },
    },
  },
  plugins: [],
}
