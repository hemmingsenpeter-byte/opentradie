import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { ApiError, getMe, getState, logout, setUnauthorizedListener } from './api';
import { Brand, Icon } from './components/Icons';
import type { IconName } from './components/Icons';
import { ErrorNotice, Loading, MockBadge } from './components/ui';
import { href, useRoute } from './router';
import type { Tab } from './router';
import { ApprovalsScreen } from './screens/Approvals';
import { AssistantScreen } from './screens/Assistant';
import { CustomersScreen } from './screens/Customers';
import { HomeScreen } from './screens/Home';
import { InboxScreen } from './screens/Inbox';
import { InvoicesScreen } from './screens/Invoices';
import { JobsScreen } from './screens/Jobs';
import { LoginScreen } from './screens/Login';
import { QuotesScreen } from './screens/Quotes';
import { SettingsScreen } from './screens/Settings';
import type { AppState } from './types';
import { ConversationProvider, useWorkspace, WorkspaceProvider } from './workspace';

// FullCalendar is large; load it only when the Calendar tab opens.
const CalendarScreen = lazy(() =>
  import('./screens/Calendar').then((module) => ({ default: module.CalendarScreen })),
);

type Phase = 'checking' | 'signed-out' | 'ready' | 'failed';

export function App() {
  const [phase, setPhase] = useState<Phase>('checking');
  const [state, setState] = useState<AppState | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
  const [loginMessage, setLoginMessage] = useState('');

  const reload = useCallback(async () => {
    setState(await getState());
  }, []);

  const boot = useCallback(async () => {
    setPhase('checking');
    setFailure(null);
    try {
      await getMe();
      await reload();
      setPhase('ready');
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        setPhase('signed-out');
      } else {
        setFailure(error);
        setPhase('failed');
      }
    }
  }, [reload]);

  useEffect(() => {
    setUnauthorizedListener(() => {
      setState(null);
      setLoginMessage('Your session has ended. Sign in again to carry on.');
      setPhase('signed-out');
    });
    void boot();
    return () => setUnauthorizedListener(null);
  }, [boot]);

  const signOut = useCallback(async () => {
    try {
      await logout();
    } finally {
      setState(null);
      setLoginMessage('You have signed out.');
      setPhase('signed-out');
    }
  }, []);

  if (phase === 'checking') {
    return (
      <main className="boot">
        <Brand />
        <Loading label="Opening your workspace…" />
      </main>
    );
  }
  if (phase === 'signed-out') {
    return <LoginScreen message={loginMessage} onSignedIn={boot} />;
  }
  if (phase === 'failed' || !state) {
    return (
      <main className="boot">
        <Brand />
        <div className="w-full max-w-md">
          <ErrorNotice
            title="Your workspace didn’t load"
            error={failure}
            retry={() => void boot()}
          />
        </div>
      </main>
    );
  }
  return (
    <WorkspaceProvider state={state} reload={reload} signOut={signOut}>
      <ConversationProvider reload={reload}>
        <Shell />
      </ConversationProvider>
    </WorkspaceProvider>
  );
}

const NAV: { tab: Tab; label: string; icon: IconName }[] = [
  { tab: 'home', label: 'Home', icon: 'home' },
  { tab: 'customers', label: 'Customers', icon: 'customers' },
  { tab: 'assistant', label: 'Assistant', icon: 'assistant' },
  { tab: 'jobs', label: 'Jobs', icon: 'jobs' },
  { tab: 'quotes', label: 'Quotes', icon: 'quotes' },
  { tab: 'calendar', label: 'Calendar', icon: 'calendar' },
];

function Shell() {
  const route = useRoute();
  const { state, isOwner, isMockAgent } = useWorkspace();
  const pending = state.quotes.filter((quote) => quote.status === 'draft').length;

  useEffect(() => {
    const titles: Record<Tab, string> = {
      home: 'Home',
      customers: 'Customers',
      jobs: 'Jobs',
      quotes: 'Quotes',
      invoices: 'Invoices',
      calendar: 'Calendar',
      assistant: 'Assistant',
      settings: 'Settings',
      approvals: 'Approvals',
      inbox: 'Inbox',
    };
    document.title = `${titles[route.tab]} · OPENTRADIE`;
  }, [route.tab]);

  return (
    <div className="shell">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="topbar">
        <a href={href('home')} className="topbar-brand" aria-label="OPENTRADIE home">
          <Brand compact />
        </a>
        <div className="topbar-meta">
          <span className="topbar-business">{state.business.name}</span>
          <span className={`role-chip ${isOwner ? 'role-owner' : 'role-viewer'}`}>
            {isOwner ? 'Owner' : 'View only'}
          </span>
        </div>
        <a
          href={href('settings')}
          className={`icon-btn topbar-settings ${route.tab === 'settings' ? 'is-active' : ''}`}
          aria-label="Settings"
          aria-current={route.tab === 'settings' ? 'page' : undefined}
        >
          <Icon name="settings" />
        </a>
      </header>
      <div className="hazard" aria-hidden="true" />
      {isMockAgent && (
        <div className="mock-strip">
          <MockBadge />
          <span className="mock-strip-text">
            Demo mode: the assistant uses a fixed parser. Prices still come only from your approved
            rates.
          </span>
        </div>
      )}

      <nav className="tabbar" aria-label="Main">
        <ul>
          {[
            ...NAV,
            { tab: 'invoices' as Tab, label: 'Invoices', icon: 'file' as IconName },
            { tab: 'settings' as Tab, label: 'Settings', icon: 'settings' as IconName },
          ].map((item) => (
            <li
              key={item.tab}
              className={
                item.tab === 'settings' || item.tab === 'invoices'
                  ? 'tab-settings'
                  : item.tab === 'assistant'
                    ? 'tab-assistant'
                    : ''
              }
            >
              <a href={href(item.tab)} aria-current={route.tab === item.tab ? 'page' : undefined}>
                <span className="tab-icon">
                  <Icon name={item.icon} size={26} />
                  {item.tab === 'quotes' && pending > 0 && (
                    <span className="tab-badge" aria-label={`${pending} awaiting approval`}>
                      {pending}
                    </span>
                  )}
                </span>
                <span className="tab-label">{item.label}</span>
              </a>
            </li>
          ))}
        </ul>
      </nav>

      <main id="main" className="main" tabIndex={-1}>
        <Screen tab={route.tab} segments={route.segments} query={route.query} />
      </main>
    </div>
  );
}

function Screen({
  tab,
  segments,
  query,
}: {
  tab: Tab;
  segments: string[];
  query: URLSearchParams;
}) {
  switch (tab) {
    case 'customers':
      return <CustomersScreen segments={segments} />;
    case 'jobs':
      return <JobsScreen segments={segments} query={query} />;
    case 'quotes':
      return <QuotesScreen segments={segments} />;
    case 'invoices':
      return <InvoicesScreen segments={segments} />;
    case 'calendar':
      return (
        <Suspense fallback={<Loading label="Opening the calendar…" />}>
          <CalendarScreen />
        </Suspense>
      );
    case 'assistant':
      return <AssistantScreen />;
    case 'settings':
      return <SettingsScreen />;
    case 'approvals':
      return <ApprovalsScreen />;
    case 'inbox':
      return <InboxScreen segments={segments} />;
    default:
      return <HomeScreen />;
  }
}
