import React from 'react'
import ReactDOM from 'react-dom/client'

import App from '@/App'
import '@/index.css'
import 'katex/dist/katex.min.css'

// Initialize i18n
import { i18nReady } from '@/modules/i18n'

// React Scan is a render-diagnostics overlay, and an expensive one: measured on
// this app it roughly halves the dev frame rate, adds ~14 MB of heap and injects
// a few thousand DOM nodes of its own. It is worth all of that while hunting a
// render bug and worth none of it the rest of the time, so it is opt-in —
// `localStorage.setItem('react-scan', 'on')` and reload. Imported only then, so a
// production build carries none of it (~600 KB).
if (import.meta.env.DEV && localStorage.getItem('react-scan') === 'on') {
  void import('react-scan').then(({ scan }) => scan({ enabled: true }))
}

// Register service worker for PWA + Web Push support
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(err => {
    console.warn('Service worker registration failed:', err);
  });
}

const rootElement = document.getElementById('root')
if (!rootElement) {
  throw new Error('Unable to mount the app: #root is missing from the document')
}

// The browser's context menu (right click, long press) never opens outside text fields, the editor, the
// terminal and text marked copyable (their own menus/selection still work); app menus take its place.
// Over a text selection (chat text dragged with a mouse) it opens, so "copy" is there.
document.addEventListener('contextmenu', (event) => {
  if (window.getSelection()?.toString()) return;
  if (!(event.target instanceof Element) || !event.target.closest('input, textarea, [contenteditable="true"], .cm-editor, .xterm, .aidev-selectable')) event.preventDefault();
});

// The saved language's translations (a download unless it is English) arrive before the first render, so no
// screen shows English first; a failed download renders in English rather than not at all.
void i18nReady.catch(() => undefined).then(() => {
  ReactDOM.createRoot(rootElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  )
})
