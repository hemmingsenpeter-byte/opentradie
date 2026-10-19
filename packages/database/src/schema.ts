import { bigint, boolean, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

export const businesses = pgTable('businesses', {
  id: uuid('id').primaryKey(),
  name: text('name').notNull(),
  currency: text('currency').notNull(),
  timeZone: text('time_zone').notNull(),
  demoData: boolean('demo_data').notNull(),
  taxBasisPoints: integer('tax_basis_points').notNull(),
});
export const customers = pgTable('customers', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  name: text('name').notNull(),
  email: text('email'),
  phone: text('phone'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
});
export const jobs = pgTable('jobs', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  customerId: uuid('customer_id').notNull(),
  title: text('title').notNull(),
  status: text('status').notNull(),
  notes: text('notes'),
});
export const approvedRates = pgTable('approved_rates', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  code: text('code').notNull(),
  label: text('label').notNull(),
  unitPriceCents: bigint('unit_price_cents', { mode: 'number' }).notNull(),
  active: boolean('active').notNull(),
});
export const quotes = pgTable('quotes', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  customerId: uuid('customer_id').notNull(),
  jobId: uuid('job_id').notNull(),
  status: text('status').notNull(),
  version: integer('version').notNull(),
  assumptions: jsonb('assumptions').$type<string[]>().notNull(),
  missingInformation: jsonb('missing_information').$type<string[]>().notNull(),
  subtotalCents: bigint('subtotal_cents', { mode: 'number' }).notNull(),
  taxCents: bigint('tax_cents', { mode: 'number' }).notNull(),
  totalCents: bigint('total_cents', { mode: 'number' }).notNull(),
  taxBasisPoints: integer('tax_basis_points').notNull(),
});
