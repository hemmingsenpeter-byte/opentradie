/**
 * Customer tags, duplicates and merge, and customer reports (ADR 0034). Same request() rules as api.ts.
 */
import { request } from './api';
import type { Customer } from './types';

export const TAG_COLOURS = [
  'slate',
  'red',
  'amber',
  'green',
  'teal',
  'blue',
  'violet',
  'pink',
] as const;
export type TagColour = (typeof TAG_COLOURS)[number];

export interface TagRef {
  id: string;
  name: string;
  colour: string;
}
export interface Tag extends TagRef {
  customerCount: number;
  createdAt: string;
}

export const listTags = () => request<{ tags: Tag[] }>('/api/tags');
export const createTag = (name: string, colour: TagColour = 'slate') =>
  request<Tag>('/api/tags', { method: 'POST', body: { name, colour } });
export const updateTag = (id: string, body: { name?: string; colour?: TagColour }) =>
  request<Tag>(`/api/tags/${id}`, { method: 'PATCH', body });
export const deleteTag = (id: string) =>
  request<{ deleted: true; removedFrom: number }>(`/api/tags/${id}`, { method: 'DELETE' });
export const setCustomerTags = (customerId: string, tagIds: string[]) =>
  request<Customer>(`/api/customers/${customerId}/tags`, { method: 'PUT', body: { tagIds } });

export interface DuplicateCustomer {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  address: string | null;
  jobCount: number;
  createdAt: string;
}
export type DuplicateReason = 'email' | 'phone' | 'name_and_address' | 'similar_name';
export interface DuplicatePair {
  score: number;
  reasons: DuplicateReason[];
  customers: [DuplicateCustomer, DuplicateCustomer];
}
export interface MergePreview {
  source: { id: string; name: string };
  into: { id: string; name: string };
  alreadyMerged: boolean;
  moves: Record<string, number>;
  duplicatePropertiesArchived: number;
  warnings: { code: string; message: string }[];
}

export const listDuplicates = () =>
  request<{ pairs: DuplicatePair[] }>('/api/customers/duplicates');
export const dismissDuplicate = (id: string, otherId: string) =>
  request<{ dismissed: true }>(`/api/customers/${id}/not-duplicate`, {
    method: 'POST',
    body: { otherId },
  });
export const mergePreview = (id: string, into: string) =>
  request<MergePreview>(`/api/customers/${id}/merge-preview?into=${encodeURIComponent(into)}`);
export const mergeCustomer = (id: string, intoId: string, confirm: string) =>
  request<{ merged: true; alreadyMerged: boolean; moves: Record<string, number> }>(
    `/api/customers/${id}/merge`,
    { method: 'POST', body: { intoId, confirm } },
  );

export interface CustomerReportRow {
  customerId: string;
  name: string;
  jobs: number;
  quotesSent: number;
  quotesAccepted: number;
  winRateBp: number | null;
  invoicedExclCents: number;
  invoicedGstCents: number;
  invoicedInclCents: number;
  paidCents: number;
  outstandingCents: number;
  firstJobDate: string | null;
  lastJobDate: string | null;
  repeat: boolean;
}
export interface CustomerReport {
  range: { from: string; to: string };
  rows: CustomerReportRow[];
  summary: {
    customers: number;
    newCustomers: number;
    repeatCustomers: number;
    quotesSent: number;
    quotesAccepted: number;
    winRateBp: number | null;
    invoicedExclCents: number;
    invoicedGstCents: number;
    invoicedInclCents: number;
    paidCents: number;
    outstandingCents: number;
    averageDaysToPay: number | null;
    topCustomers: { customerId: string; name: string; invoicedInclCents: number }[];
  };
}
export type ReportPeriod = 'this_month' | 'last_month' | 'this_financial_year' | 'custom';

export function reportQuery(period: ReportPeriod, from?: string, to?: string): string {
  return period === 'custom' && from && to
    ? `from=${from}&to=${to}`
    : `period=${period === 'custom' ? 'this_month' : period}`;
}
export const getCustomerReport = (query: string) =>
  request<CustomerReport>(`/api/reports/customers?${query}`);
export const customerReportCsvUrl = (query: string) => `/api/reports/customers?${query}&format=csv`;

/** Tag colour → an existing accessible pill tone (no new colours to contrast-check). */
export const TAG_TONE: Record<string, 'neutral' | 'rejected' | 'draft' | 'approved' | 'info'> = {
  slate: 'neutral',
  red: 'rejected',
  amber: 'draft',
  green: 'approved',
  teal: 'approved',
  blue: 'info',
  violet: 'info',
  pink: 'rejected',
};

export const formatPercent = (bp: number | null) =>
  bp === null ? '—' : `${Math.floor(bp / 100)}.${String(bp % 100).padStart(2, '0')}%`;
