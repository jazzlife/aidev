import React from 'react';
import ReactDOM from 'react-dom/client';

import App from '@m/App';
import '@m/theme/tokens.css';

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/m/sw.js', { scope: '/m/' }).catch((error) => console.warn('SW registration failed', error));
}

// The browser's own context menu (long-press on Android, right-click) never opens outside text fields;
// the app's long-press sheets take its place. Over a text selection (message text dragged with a mouse) it opens.
document.addEventListener('contextmenu', (event) => {
  if (window.getSelection()?.toString()) return;
  if (!(event.target instanceof Element) || !event.target.closest('input, textarea, [contenteditable="true"]')) event.preventDefault();
});

const root = document.getElementById('root');
if (!root) {
  throw new Error('#root missing');
}
ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
