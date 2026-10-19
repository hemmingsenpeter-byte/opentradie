export interface Customer { id: string; name: string; email?: string | null; phone?: string | null }
export interface Job { id: string; customerId: string; title: string; status: string; notes?: string | null }
export interface Communication { id: string; customerId?: string | null; text: string; createdAt: string }
export interface Quote {
  id: string; jobId: string; customerId: string; status: 'draft' | 'approved'; version: number;
  assumptions: string[]; missingInformation: string[]; subtotalCents: number; taxCents: number; totalCents: number;
  lines: { description: string; quantity: number; unitPriceCents: number; lineTotalCents: number }[];
}
export interface AppState {
  business: { id: string; name: string; currency: string; timeZone: string; taxBasisPoints: number };
  user: { id: string; email: string; role: string };
  customers: Customer[]; jobs: Job[]; communications: Communication[]; quotes: Quote[];
  rates: { code: string; label: string; unitPriceCents: number }[];
  auditEvents: { id: string; action: string; createdAt: string }[];
  settings: { profile: string; privacyMode: string; agentMode: string; agentHealth: string | { status: string; message?: string }; demoData?: boolean };
}
export interface EnquiryResult { enquiryId?: string; jobId?: string; quoteId?: string; clarification?: { message: string; matches: { id: string; name: string }[] } }
export type Page = 'home' | 'inbox' | 'customers' | 'jobs' | 'quotes' | 'assistant' | 'settings';
