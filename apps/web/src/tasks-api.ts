/**
 * Tasks and Today calls (Feature 16, ADR 0032). Same request() rules as api.ts.
 */
import { request } from './api';

export type TaskKind =
  | 'book_job'
  | 'call'
  | 'follow_up_quote'
  | 'reply_message'
  | 'invoice_job'
  | 'chase_payment'
  | 'custom';

export interface Task {
  id: string;
  kind: TaskKind;
  title: string;
  notes: string | null;
  dueAt: string | null;
  priority: 'low' | 'normal' | 'high';
  status: 'open' | 'snoozed' | 'done' | 'dismissed';
  snoozedUntil: string | null;
  source: string;
  customerId: string | null;
  customerName: string | null;
  customerPhone: string | null;
  jobId: string | null;
  jobTitle: string | null;
  quoteId: string | null;
  quoteNumber: string | null;
  invoiceId: string | null;
  invoiceNumber: string | null;
  threadId: string | null;
  bucket: 'overdue' | 'today' | 'upcoming' | 'snoozed' | 'closed';
}

export interface TodayAppointment {
  id: string;
  jobId: string;
  jobTitle: string;
  customerName: string;
  startsAt: string;
  endsAt: string;
  status: string;
  location: string | null;
}

export interface Today {
  timeZone: string;
  date: string;
  counts: { overdue: number; today: number; upcoming: number; snoozed: number; due: number };
  overdue: Task[];
  today: Task[];
  upcoming: Task[];
  snoozed: Task[];
  appointments: TodayAppointment[];
}

/** Fired after any task change so the Home badge refreshes. */
export const TASKS_CHANGED = 'opentradie:tasks-changed';
const changed = <T>(value: T) => {
  window.dispatchEvent(new Event(TASKS_CHANGED));
  return value;
};

export const getToday = () => request<Today>('/api/today');
export const createTask = (body: { title: string; kind?: TaskKind; dueAt?: string | null }) =>
  request<{ task: Task }>('/api/tasks', { method: 'POST', body }).then(changed);
export const taskAction = (id: string, action: 'complete' | 'dismiss' | 'reopen') =>
  request<{ task: Task }>(`/api/tasks/${id}/${action}`, { method: 'POST', body: {} }).then(changed);
export const snoozeTask = (id: string, until: string) =>
  request<{ task: Task }>(`/api/tasks/${id}/snooze`, { method: 'POST', body: { until } }).then(
    changed,
  );
export const runTaskScan = () =>
  request<{ created: number; resolved: number }>('/api/tasks/scan', {
    method: 'POST',
    body: {},
  }).then(changed);
