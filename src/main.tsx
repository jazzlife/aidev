import React from 'react'
import ReactDOM from 'react-dom/client'
import { scan } from 'react-scan'

import App from '@/App'
import '@/index.css'
import 'katex/dist/katex.min.css'

// Initialize i18n
import '@/modules/i18n'

// React Scan is a render-diagnostics overlay, and an expensive one: measured on
// this app it roughly halves the dev frame rate, adds ~14 MB of heap and injects
// a few thousand DOM nodes of its own. It is worth all of that while hunting a
// render bug and worth none of it the rest of the time, so it is opt-in —
// `localStorage.setItem('react-scan', 'on')` and reload.
scan({ enabled: import.meta.env.DEV && localStorage.getItem('react-scan') === 'on' })

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

// Touch devices: the browser's long-press menu never opens outside text fields, the editor and the
// terminal (their own menus/selection still work); app menus take its place.
if (window.matchMedia('(pointer: coarse)').matches) {
  document.addEventListener('contextmenu', (event) => {
    if (!(event.target instanceof Element) || !event.target.closest('input, textarea, [contenteditable="true"], .cm-editor, .xterm')) event.preventDefault();
  });
}

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
