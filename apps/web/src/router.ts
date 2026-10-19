import { useEffect, useState } from 'react';

/**
 * Hash routes keep the PWA deployable behind any static host and the Fastify SPA fallback.
 * Shapes: #/home, #/customers, #/customers/new, #/customers/:id, #/customers/:id/edit,
 * #/jobs, #/jobs/new?customer=:id, #/jobs/:id, #/quotes, #/quotes/:id, #/assistant, #/settings,
 * #/approvals
 */
export type Tab = 'home' | 'customers' | 'jobs' | 'quotes' | 'assistant' | 'settings' | 'approvals';
const TABS: Tab[] = ['home', 'customers', 'jobs', 'quotes', 'assistant', 'settings', 'approvals'];

export interface Route {
  tab: Tab;
  segments: string[];
  query: URLSearchParams;
}

export function parseHash(hash: string): Route {
  const raw = hash.replace(/^#\/?/, '');
  const [path = '', search = ''] = raw.split('?');
  const [first, ...segments] = path.split('/').filter(Boolean).map(decodeURIComponent);
  const tab = TABS.includes(first as Tab) ? (first as Tab) : 'home';
  return { tab, segments: tab === first ? segments : [], query: new URLSearchParams(search) };
}

export const href = (...parts: string[]) => `#/${parts.map(encodeURIComponent).join('/')}`;

export function navigate(to: string) {
  window.location.hash = to.startsWith('#') ? to.slice(1) : to;
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseHash(window.location.hash));
  useEffect(() => {
    const update = () => {
      setRoute(parseHash(window.location.hash));
      window.scrollTo?.(0, 0);
    };
    window.addEventListener('hashchange', update);
    return () => window.removeEventListener('hashchange', update);
  }, []);
  return route;
}
