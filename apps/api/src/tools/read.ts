import type { ToolName } from '@opentradie/core';
import type { Queryable } from '@opentradie/database';
import { HttpError } from '../http.js';
import { getJob, getQuote, listCustomers, listJobs, loadRates } from '../services/records.js';
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
      return {
        status: 'not_available',
        reason: 'Invoices and payments are not available in this version of OPENTRADIE.',
      };
    }
    default:
      throw new HttpError(400, 'NOT_A_READ_TOOL', 'This tool is not a read tool.');
  }
}
