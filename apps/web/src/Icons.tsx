export type IconName = 'home' | 'inbox' | 'customers' | 'jobs' | 'quotes' | 'assistant' | 'settings' | 'arrow' | 'plus' | 'chevron' | 'check' | 'close' | 'search' | 'clock' | 'shield' | 'logout' | 'mail' | 'phone' | 'back' | 'refresh' | 'warning' | 'file' | 'bolt';
const paths: Record<IconName, string> = {
  home: 'm3 10 9-7 9 7v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1z',
  inbox: 'M4 4h16l2 11v5H2v-5zm-2 11h6l2 3h4l2-3h6',
  customers: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2m20 0v-2a4 4 0 0 0-3-3.87M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8m8-7.87a4 4 0 0 1 0 7.75',
  jobs: 'M9 5V3h6v2M3 6h18v15H3zm0 6h18m-11-1v3h4v-3',
  quotes: 'M14 2H5v20h14V7zm0 0v6h5M8 12h8m-8 4h5',
  assistant: 'm12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5zM20 2v4m-2-2h4',
  settings: 'M9 3h6l1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1zm6 9a3 3 0 1 1-6 0 3 3 0 0 1 6 0',
  arrow: 'M5 12h14m-6-6 6 6-6 6', plus: 'M12 5v14M5 12h14', chevron: 'm9 5 7 7-7 7', check: 'm5 12 4 4L19 6',
  close: 'm6 6 12 12M6 18 18 6', search: 'M21 21l-5-5m2-6a7 7 0 1 1-14 0 7 7 0 0 1 14 0',
  clock: 'M12 8v5l3 2m6-3a9 9 0 1 1-18 0 9 9 0 0 1 18 0',
  shield: 'm12 2 8 4v6c0 5-8 10-8 10S4 17 4 12V6zm-4 10 3 3 5-6',
  logout: 'M9 3H3v18h6m6-16 6 7-6 7m-8-7h14', mail: 'M3 5h18v14H3zm0 0 9 7 9-7',
  phone: 'M4 3h4l2 5-3 2a15 15 0 0 0 7 7l2-3 5 2v4c0 3-7 1-12-4S1 3 4 3',
  back: 'M19 12H5m6-6-6 6 6 6', refresh: 'M20 7V3l-4 4M4 17v4l4-4M4.5 8a8 8 0 0 1 13-3L20 7M4 17l2.5 2a8 8 0 0 0 13-3',
  warning: 'm12 3 10 18H2zm0 5v6m0 3h.01', file: 'M5 2h10l4 4v16H5zm10 0v5h4M8 12h8m-8 4h6',
  bolt: 'm13 2-9 12h7l-1 8 10-13h-7z',
};
export function Icon({ name, size = 20, className = '' }: { name: IconName; size?: number; className?: string }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={className}><path d={paths[name]} /></svg>;
}
export function Brand({ compact = false }: { compact?: boolean }) {
  return <div className="brand"><img src="/icon.svg" alt="" width="36" height="36" />{!compact && <span>OPEN<span className="brand-light">TRADIE</span><small>YOUR BUSINESS, IN HAND</small></span>}</div>;
}
