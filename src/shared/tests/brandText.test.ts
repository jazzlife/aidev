import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * The app is NadoVibe: no on-screen text may name the upstream CloudCLI. Covers the translation files (every UI
 * string), both HTML shells and both PWA manifests. Code identifiers (key names, paths) are not text and stay.
 */
const ROOT = path.resolve(__dirname, '../../..');
const LOCALES = path.join(ROOT, 'src/modules/i18n/locales');
const BRAND = /cloudcli|claude code ui/i;
/** Text the user cannot see in NadoVibe: the upstream upgrade command of the version modal, which never opens. */
const ALLOWED = new Set(['common:versionUpdate.npmUpgradeCommand']);

function* strings(value: unknown, key: string): Generator<[string, string]> {
  if (typeof value === 'string') yield [key, value];
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) yield* strings(v, key.endsWith(':') ? `${key}${k}` : `${key}.${k}`);
  }
}

describe('brand text', () => {
  it('no translation string names CloudCLI', () => {
    const hits: string[] = [];
    for (const lang of fs.readdirSync(LOCALES)) {
      for (const file of fs.readdirSync(path.join(LOCALES, lang)).filter((f) => f.endsWith('.json'))) {
        const ns = file.replace(/\.json$/, '');
        const json = JSON.parse(fs.readFileSync(path.join(LOCALES, lang, file), 'utf8'));
        for (const [key, text] of strings(json, `${ns}:`)) {
          if (BRAND.test(text) && !ALLOWED.has(key)) hits.push(`${lang}/${key}: ${text}`);
        }
      }
    }
    expect(hits).toEqual([]);
  });

  it('HTML shells and manifests are NadoVibe', () => {
    for (const file of ['index.html', 'src-mobile/index.html', 'public/manifest.json', 'src-mobile/public/manifest.webmanifest']) {
      const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
      expect(text, file).toContain('NadoVibe');
      expect(BRAND.test(text), file).toBe(false);
    }
  });
});
