import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource/barlow/500.css';
import '@fontsource/barlow/600.css';
import '@fontsource/barlow/700.css';
import '@fontsource/barlow-condensed/700.css';
import '@fontsource/barlow-condensed/800.css';
import './styles.css';
import { App } from './App';
import { acceptanceTokenFromPath, PublicQuoteScreen } from './screens/PublicQuote';

// Customer acceptance links (/q/<token>) render a public page with no sign-in.
const publicToken = acceptanceTokenFromPath(window.location.pathname);
const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element');
createRoot(root).render(
  <StrictMode>{publicToken ? <PublicQuoteScreen token={publicToken} /> : <App />}</StrictMode>,
);

// The service worker caches only the public app shell; it never touches /api or /health.
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js').catch(() => undefined);
  });
}
