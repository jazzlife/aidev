/**
 * i18n Configuration
 *
 * Configures i18next for internationalization support.
 * Features:
 * - English (the fallback) and Korean (the main language) are bundled; every other language downloads when chosen
 * - Language detection from localStorage
 * - Fallback to English for missing translations
 * - Development mode warnings for missing keys
 */

import i18n, { type BackendModule } from 'i18next';
import { initReactI18next } from 'react-i18next';

// Import translation resources
import enCommon from '@/modules/i18n/locales/en/common.json';
import enSettings from '@/modules/i18n/locales/en/settings.json';
import enAuth from '@/modules/i18n/locales/en/auth.json';
import enSidebar from '@/modules/i18n/locales/en/sidebar.json';
import enChat from '@/modules/i18n/locales/en/chat.json';
import enCodeEditor from '@/modules/i18n/locales/en/codeEditor.json';
// oxlint-disable-next-line importx/order
import enTasks from '@/modules/i18n/locales/en/tasks.json';
// oxlint-disable-next-line importx/order
import enGit from '@/modules/i18n/locales/en/git.json';

// Korean, this app's main language, is bundled too: loaded on demand it cost a Korean user one more round trip
// before the first paint (3.4 s on the slow CDN path, 2026-10-13) for ~15 KB gzipped.
import koCommon from '@/modules/i18n/locales/ko/common.json';
import koSettings from '@/modules/i18n/locales/ko/settings.json';
import koAuth from '@/modules/i18n/locales/ko/auth.json';
import koSidebar from '@/modules/i18n/locales/ko/sidebar.json';
import koChat from '@/modules/i18n/locales/ko/chat.json';
import koCodeEditor from '@/modules/i18n/locales/ko/codeEditor.json';
// oxlint-disable-next-line importx/order
import koTasks from '@/modules/i18n/locales/ko/tasks.json';

// Import supported languages configuration
import { languages } from '@/modules/i18n/languages';
import {
  readUserPreference,
  subscribeToUserPreferences,
  writeUserPreference,
} from '@/shared/userSettings';

// The chosen language lives in auth.db so it follows the user between devices.
// It is read synchronously from the preference mirror because i18n has to be
// configured at module load, long before any request could resolve.
const getSavedLanguage = (): string => {
  const saved = readUserPreference<string | null>('userLanguage', null);
  // Validate that the saved language is supported
  if (saved && languages.some(lang => lang.value === saved)) {
    return saved;
  }
  return 'en';
};

// Every other language's namespaces, one chunk each, downloaded only for the language in use: bundling all
// thirteen put ~500 KB of translations nobody reads into the app's first download.
const localeLoaders = new Map(
  Object.entries(import.meta.glob<Record<string, unknown>>(
    ['@/modules/i18n/locales/*/*.json', '!@/modules/i18n/locales/en/*.json', '!@/modules/i18n/locales/ko/*.json'],
    { import: 'default' },
  )).flatMap(([file, load]) => {
    const match = file.match(/locales\/([^/]+)\/([^/]+)\.json$/);
    return match ? [[`${match[1]}/${match[2]}`, load] as const] : [];
  }),
);

// i18next asks for each language/namespace it lacks and switches language only once they arrived (it retries
// a failed download a few times, then falls back to English).
const lazyLocales: BackendModule = {
  type: 'backend',
  init: () => undefined,
  read(language, namespace, callback) {
    const load = localeLoaders.get(`${language}/${namespace}`);
    // English and Korean are bundled, and a language without this namespace falls back to English
    if (!load) {
      callback(null, {});
      return;
    }
    load().then((data) => callback(null, data), (error: Error) => callback(error, null));
  },
};

// Initialize i18next. Resolves once the saved language's translations are in, which main.tsx waits for
// before the first render so the app never shows English first.
export const i18nReady = i18n
  .use(lazyLocales)
  .use(initReactI18next) // Pass i18n instance to react-i18next
  .init({
    // English and Korean; partialBundledLanguages lets the backend load the rest
    partialBundledLanguages: true,
    resources: {
      en: {
        common: enCommon,
        settings: enSettings,
        auth: enAuth,
        sidebar: enSidebar,
        chat: enChat,
        codeEditor: enCodeEditor,
        tasks: enTasks,
git: enGit,
      },
      ko: {
        common: koCommon,
        settings: koSettings,
        auth: koAuth,
        sidebar: koSidebar,
        chat: koChat,
        codeEditor: koCodeEditor,
        tasks: koTasks,
      },
    },

    // Default language
    lng: getSavedLanguage(),

    // Fallback language when a translation is missing
    fallbackLng: 'en',

    // Enable debug mode in development (logs missing keys to console)
    debug: false,

    // Namespaces - load only what's needed
    ns: ['common', 'settings', 'auth', 'sidebar', 'chat', 'codeEditor', 'tasks', 'git'],
    defaultNS: 'common',

    // Key separator for nested keys (default: '.')
    keySeparator: '.',

    // Namespace separator (default: ':')
    nsSeparator: ':',

    // Save missing translations (disabled - requires manual review)
    saveMissing: false,

    // Interpolation settings
    interpolation: {
      escapeValue: false, // React already escapes values
    },

    // React-specific settings
    react: {
      useSuspense: true, // Use Suspense for lazy-loading
      bindI18n: 'languageChanged', // Re-render on language change
      bindI18nStore: false, // Don't re-render on resource changes
    },
  });

// Save language preference when it changes
i18n.on('languageChanged', (lng: string) => {
  writeUserPreference('userLanguage', lng);
});

// A language chosen on another device arrives with the hydrated preferences,
// after i18n was already initialized with whatever the mirror held.
subscribeToUserPreferences(() => {
  const saved = readUserPreference<string | null>('userLanguage', null);
  if (saved && saved !== i18n.language && languages.some(lang => lang.value === saved)) {
    void i18n.changeLanguage(saved);
  }
});

export default i18n;
