import React from 'react';
import ReactDOM from 'react-dom/client';

import App from '@m/App';
import '@m/theme/tokens.css';

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/m/sw.js', { scope: '/m/' }).catch((error) => console.warn('SW registration failed', error));
}

const root = document.getElementById('root');
if (!root) {
  throw new Error('#root missing');
}
ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
