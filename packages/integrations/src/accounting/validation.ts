import { MAX_AMOUNT_CENTS } from '@opentradie/core';
import { ValidationError } from '../errors.js';
import { taxCodes, type ContactInput, type DraftInvoiceInput, type WriteOptions } from './types.js';

/** Pre-flight validation shared by every adapter, run before any provider call. */

const IDEMPOTENCY_KEY = /^[A-Za-z0-9_.:-]{1,128}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_QUANTITY_MILLI = 100_000_000; // 100,000 units

function isRealDate(value: string): boolean {
  if (!DATE.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function assertWriteOptions(options: WriteOptions, provider: string): void {
  if (
    !options ||
    typeof options.idempotencyKey !== 'string' ||
    !IDEMPOTENCY_KEY.test(options.idempotencyKey)
  ) {
    throw new ValidationError('A valid idempotency key is required.', 'idempotency_key', provider, [
      'idempotencyKey must be 1-128 characters of letters, digits, "_", ".", ":" or "-".',
    ]);
  }
}

export function validateContact(input: ContactInput, provider: string): void {
  const issues: string[] = [];
  if (!input.customerId || input.customerId.length > 50)
    issues.push('customerId must be 1-50 characters.');
  if (!input.name?.trim() || input.name.length > 255) issues.push('name must be 1-255 characters.');
  if (input.email && (input.email.length > 255 || !/^[^\s@]+@[^\s@]+$/.test(input.email)))
    issues.push('email is not a valid address.');
  if (input.phone && input.phone.length > 50) issues.push('phone must be at most 50 characters.');
  if (issues.length) throw new ValidationError('Contact is invalid.', 'contact', provider, issues);
}

export function validateDraftInvoice(input: DraftInvoiceInput, provider: string): void {
  const issues: string[] = [];
  if (!input.externalContactId) issues.push('externalContactId is required.');
  if (!input.invoiceNumber || input.invoiceNumber.length > 255)
    issues.push('invoiceNumber must be 1-255 characters.');
  if (!isRealDate(input.issueDate)) issues.push('issueDate must be a YYYY-MM-DD date.');
  if (!isRealDate(input.dueDate)) issues.push('dueDate must be a YYYY-MM-DD date.');
  if (isRealDate(input.issueDate) && isRealDate(input.dueDate) && input.dueDate < input.issueDate)
    issues.push('dueDate must not be before issueDate.');
  if (!/^[A-Z]{3}$/.test(input.currency)) issues.push('currency must be an ISO 4217 code.');
  if (!['exclusive', 'inclusive', 'no_tax'].includes(input.lineAmountMode))
    issues.push('lineAmountMode is not supported.');
  if (!Array.isArray(input.lines) || input.lines.length === 0 || input.lines.length > 500)
    issues.push('An invoice needs 1-500 lines.');
  (input.lines ?? []).forEach((line, index) => {
    const at = `lines[${index}]`;
    if (!line.description?.trim() || line.description.length > 4000)
      issues.push(`${at}.description must be 1-4000 characters.`);
    if (
      !Number.isSafeInteger(line.quantityMilli) ||
      line.quantityMilli <= 0 ||
      line.quantityMilli > MAX_QUANTITY_MILLI
    )
      issues.push(`${at}.quantityMilli must be a positive whole number of thousandths.`);
    if (
      !Number.isSafeInteger(line.unitAmountCents) ||
      line.unitAmountCents < 0 ||
      line.unitAmountCents > MAX_AMOUNT_CENTS
    )
      issues.push(`${at}.unitAmountCents must be a non-negative whole number of cents.`);
    if (!line.accountCode || !/^[A-Za-z0-9._-]{1,10}$/.test(line.accountCode))
      issues.push(`${at}.accountCode must be 1-10 characters.`);
    if (!taxCodes.includes(line.taxCode)) issues.push(`${at}.taxCode is not supported.`);
  });
  if (issues.length)
    throw new ValidationError('Draft invoice is invalid.', 'invoice', provider, issues);
}
