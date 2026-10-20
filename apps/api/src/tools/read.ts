import type { ToolName } from '@opentradie/core';
import type { Queryable } from '@opentradie/database';
import { HttpError } from '../http.js';
import { getInvoice, listInvoices } from '../services/invoices.js';
import { getJob, getQuote, listCustomers, listJobs, loadRates } from '../services/records.js';
import { findAvailableSlots } from '../services/scheduling.js';
import { buildCustomerContext, buildJobContext } from './context.js';

type Input = Record<string, unknown>;

/**
 * Read tools: tenant-scoped, field-minimised, bounded. The tenant always comes from the
 * installation, never from tool arguments.
 */
export async function runReadTool(
  client: Queryable,
  tenantId: string,
  tool: ToolName,
  input: Input,
): Promise<Record<string, unknown>> {
  switch (tool) {
    case 'customer.find': {
      const customers = await listCustomers(
        client,
        tenantId,
        input.query as string,
        input.limit as number,
      );
      return {
        customers: customers.map(({ id, name, preferredName }) => ({ id, name, preferredName })),
      };
    }
    case 'customer.get':
      return buildCustomerContext(client, tenantId, input.customerId as string);
    case 'job.find': {
      const jobs = await listJobs(client, tenantId, {
        q: input.query as string | undefined,
        status: input.status as string | undefined,
        customerId: input.customerId as string | undefined,
        limit: input.limit as number,
      });
      return {
        jobs: jobs.map(({ id, title, status, customerId, customerName, createdAt }) => ({
          id,
          title,
          status,
          customerId,
          customerName,
          createdAt,
        })),
      };
    }
    case 'job.get':
      return buildJobContext(client, tenantId, input.jobId as string);
    case 'quote.get': {
      const quote = await getQuote(client, tenantId, input.quoteId as string);
      return {
        quote: {
          id: quote.id,
          jobId: quote.jobId,
          status: quote.status,
          version: quote.version,
          currency: quote.currency,
          lines: quote.lines,
          subtotalCents: quote.subtotalCents,
          taxCents: quote.taxCents,
          totalCents: quote.totalCents,
          assumptions: quote.assumptions,
          missingInformation: quote.missingInformation,
          pricedBy: 'backend from approved rates',
        },
      };
    }
    case 'rates.list': {
      const rates = await loadRates(client, tenantId);
      // Codes, labels and units only: the agent never needs a price to propose work.
      return { rates: rates.map(({ code, label, unit }) => ({ code, label, unit })) };
    }
    case 'payment.status': {
      if (input.jobId) await getJob(client, tenantId, input.jobId as string);
      const invoices = input.invoiceId
        ? [await getInvoice(client, tenantId, input.invoiceId as string)]
        : await listInvoices(client, tenantId, { jobId: input.jobId as string });
      // Status and amounts only: no customer contact details, lines or sync error detail.
      const followUps = new Map(
        (
          await client.query<{ invoiceId: string; stage: string; status: string; hold: boolean }>(
            `SELECT i.id AS "invoiceId",i.collections_hold AS hold,r.payload->>'stage' AS stage,r.status
             FROM invoices i LEFT JOIN LATERAL (SELECT payload,status FROM reminders r WHERE r.tenant_id=i.tenant_id
               AND r.subject_type='invoice' AND r.subject_id=i.id ORDER BY created_at DESC LIMIT 1) r ON true
             WHERE i.tenant_id=$1 AND i.id=ANY($2::uuid[])`,
            [tenantId, invoices.map((invoice) => invoice.id)],
          )
        ).rows.map((row) => [row.invoiceId, row]),
      );
      return {
        invoices: invoices.map((invoice) => ({
          id: invoice.id,
          invoiceNumber: invoice.invoiceNumber,
          jobId: invoice.jobId,
          status: invoice.status,
          currency: invoice.currency,
          totalCents: invoice.totalCents,
          dueDate: invoice.dueDate,
          amountPaidCents: invoice.accounting.amountPaidCents,
          amountDueCents: invoice.accounting.amountDueCents,
          ledgerStatus: invoice.accounting.providerStatus,
          lastCheckedAt: invoice.accounting.lastReconciledAt,
          // Read-only: the latest payment follow-up stage and whether follow-ups are on hold.
          followUp: {
            stage: followUps.get(invoice.id)?.stage ?? null,
            status: followUps.get(invoice.id)?.status ?? null,
            onHold: followUps.get(invoice.id)?.hold ?? false,
          },
        })),
        note: 'Paid and due amounts come from the accounting system and are only as fresh as lastCheckedAt.',
      };
    }
    case 'schedule.availability': {
      // Free times only: busy appointments are never described to the agent.
      const availability = await findAvailableSlots(client, tenantId, {
        date: input.date as string | undefined,
        durationMinutes: input.durationMinutes as number,
        days: input.days as number,
        limit: input.limit as number,
        stepMinutes: 30,
      });
      return {
        timeZone: availability.timeZone,
        durationMinutes: availability.durationMinutes,
        fromDate: availability.fromDate,
        days: availability.days,
        slots: availability.slots,
        note: 'Propose one of these with schedule.propose; the owner confirms every booking.',
      };
    }
    default:
      throw new HttpError(400, 'NOT_A_READ_TOOL', 'This tool is not a read tool.');
  }
}
