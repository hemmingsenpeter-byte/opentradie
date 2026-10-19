import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { newIdempotencyKey, submitEnquiry } from './api';
import { formatMoney } from './format';
import type { AppState, EnquiryResult } from './types';

export interface Workspace {
  state: AppState;
  isOwner: boolean;
  isMockAgent: boolean;
  reload: () => Promise<void>;
  signOut: () => Promise<void>;
  money: (cents: number) => string;
  customerName: (id: string | null | undefined) => string;
}

const WorkspaceContext = createContext<Workspace | null>(null);

export function WorkspaceProvider({
  state,
  reload,
  signOut,
  children,
}: {
  state: AppState;
  reload: () => Promise<void>;
  signOut: () => Promise<void>;
  children: ReactNode;
}) {
  const value = useMemo<Workspace>(() => {
    const names = new Map(state.customers.map((customer) => [customer.id, customer.name]));
    return {
      state,
      reload,
      signOut,
      isOwner: state.user.role === 'owner',
      isMockAgent: state.settings.agentMode === 'mock',
      money: (cents) => formatMoney(cents, state.business.currency),
      customerName: (id) => (id && names.get(id)) || 'Unknown customer',
    };
  }, [state, reload, signOut]);
  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace(): Workspace {
  const value = useContext(WorkspaceContext);
  if (!value) throw new Error('useWorkspace must be used inside WorkspaceProvider');
  return value;
}

// --- Assistant conversation ---------------------------------------------------

export interface Turn {
  id: string;
  text: string;
  /** Set when the owner picked a customer to resolve a clarification. */
  customerId?: string;
  customerLabel?: string;
  /** Reused on retry so a repeated submission cannot create a second job or quote. */
  idempotencyKey: string;
  status: 'pending' | 'done' | 'error';
  result?: EnquiryResult;
  error?: unknown;
}

interface Conversation {
  turns: Turn[];
  busy: boolean;
  ask: (text: string, customer?: { id: string; name: string }) => Promise<void>;
  retry: (turnId: string) => Promise<void>;
  clear: () => void;
}

const ConversationContext = createContext<Conversation | null>(null);

export function ConversationProvider({
  reload,
  children,
}: {
  reload: () => Promise<void>;
  children: ReactNode;
}) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const busy = turns.some((turn) => turn.status === 'pending');

  const run = useCallback(
    async (turn: Turn) => {
      setTurns((current) =>
        current.map((entry) =>
          entry.id === turn.id ? { ...turn, status: 'pending', error: undefined } : entry,
        ),
      );
      try {
        const result = await submitEnquiry(
          turn.customerId ? { text: turn.text, customerId: turn.customerId } : { text: turn.text },
          turn.idempotencyKey,
        );
        if (!result.clarification) await reload().catch(() => undefined);
        setTurns((current) =>
          current.map((entry) =>
            entry.id === turn.id ? { ...entry, status: 'done', result } : entry,
          ),
        );
      } catch (error) {
        setTurns((current) =>
          current.map((entry) =>
            entry.id === turn.id ? { ...entry, status: 'error', error } : entry,
          ),
        );
      }
    },
    [reload],
  );

  const ask = useCallback(
    async (text: string, customer?: { id: string; name: string }) => {
      const turn: Turn = {
        id: newIdempotencyKey(),
        text,
        customerId: customer?.id,
        customerLabel: customer?.name,
        idempotencyKey: newIdempotencyKey(),
        status: 'pending',
      };
      setTurns((current) => [...current, turn]);
      await run(turn);
    },
    [run],
  );

  const retry = useCallback(
    async (turnId: string) => {
      const turn = turns.find((entry) => entry.id === turnId);
      if (turn) await run(turn);
    },
    [turns, run],
  );

  const value = useMemo(
    () => ({ turns, busy, ask, retry, clear: () => setTurns([]) }),
    [turns, busy, ask, retry],
  );
  return <ConversationContext.Provider value={value}>{children}</ConversationContext.Provider>;
}

export function useConversation(): Conversation {
  const value = useContext(ConversationContext);
  if (!value) throw new Error('useConversation must be used inside ConversationProvider');
  return value;
}
