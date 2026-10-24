/**
 * Automations calls (Feature 17, ADR 0033). Same request() rules as api.ts: the server
 * validates every definition, enforces approval gates and is the only source of summaries.
 */
import { request } from './api';

export interface Comparison {
  field: string;
  op: string;
  value?: string | number;
}
export type Condition =
  Comparison | { all: Condition[] } | { any: Condition[] } | { not: Condition };

export interface AutomationAction {
  tool: string;
  [key: string]: unknown;
}

export interface AutomationDefinition {
  name: string;
  trigger: { event: string; filter?: Condition; schedule?: Record<string, unknown> };
  delay?: { days?: number; hours?: number; minutes?: number; at?: string };
  actions: AutomationAction[];
  limits?: { maxRunsPerEntity?: number; maxRunsPerDay?: number };
}

export interface Automation {
  id: string;
  name: string;
  definition: AutomationDefinition;
  summary: string;
  trigger: string;
  version: number;
  enabled: boolean;
  source: 'manual' | 'agent' | 'builtin';
  lastRun: { at: string; status: string } | null;
}

export interface BuiltInAutomation {
  key: string;
  name: string;
  summary: string;
  configure: { label: string; href: string };
}

export interface AutomationCatalogue {
  templates: Array<{
    key: string;
    title: string;
    description: string;
    definition: AutomationDefinition;
    summary: string | null;
  }>;
  events: Array<{ name: string; title: string; entity: string }>;
  facts: Array<{
    name: string;
    type: 'text' | 'number' | 'enum';
    label: string;
    values?: string[];
  }>;
  placeholders: Array<{ name: string; label: string }>;
}

export interface AutomationRun {
  id: string;
  event: string;
  status: string;
  outcomeCode: string | null;
  scheduledFor: string;
  proposalIds: string[];
  createdAt: string;
}

export type Validation =
  { ok: true; summary: string } | { ok: false; errors: Array<{ path: string; message: string }> };

export const fetchAutomations = () =>
  request<{ automations: Automation[]; builtIn: BuiltInAutomation[] }>('/api/automations');
export const fetchAutomationCatalogue = () =>
  request<AutomationCatalogue>('/api/automations/templates');
export const validateAutomation = (definition: AutomationDefinition) =>
  request<Validation>('/api/automations/validate', { method: 'POST', body: { definition } });
export const createAutomation = (
  input: { definition: AutomationDefinition } | { templateKey: string },
  enabled = false,
) =>
  request<{ automation: Automation }>('/api/automations', {
    method: 'POST',
    body: { ...input, enabled },
  });
export const updateAutomation = (id: string, version: number, definition: AutomationDefinition) =>
  request<{ automation: Automation }>(`/api/automations/${id}`, {
    method: 'PATCH',
    body: { version, definition },
  });
export const setAutomationEnabled = (id: string, version: number, enabled: boolean) =>
  request<{ automation: Automation }>(`/api/automations/${id}/${enabled ? 'enable' : 'disable'}`, {
    method: 'POST',
    body: { version },
  });
export const deleteAutomation = (id: string, version: number) =>
  request<{ deleted: true }>(`/api/automations/${id}`, { method: 'DELETE', body: { version } });
export const fetchAutomationRuns = (id: string) =>
  request<{ runs: AutomationRun[] }>(`/api/automations/${id}/runs`);
export const fetchAutomationEvents = (event: string) =>
  request<{ events: Array<{ id: string; event: string; occurredAt: string }> }>(
    `/api/automations/events?event=${encodeURIComponent(event)}`,
  );
export const testAutomation = (id: string, eventId: string, definition: AutomationDefinition) =>
  request<{
    matches: boolean;
    reason: string | null;
    dueAt?: string;
    actions: Array<{
      tool: string;
      input?: Record<string, unknown> | null;
      approval?: string;
      skipped?: string;
    }>;
  }>(`/api/automations/${id}/test`, { method: 'POST', body: { eventId, definition } });
