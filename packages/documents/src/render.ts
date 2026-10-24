import { Document, Page, renderToBuffer, StyleSheet, Text, View } from '@react-pdf/renderer';
import { createElement as h, type ReactElement, type ReactNode } from 'react';
import type { DocumentModel } from './model.js';

/**
 * A4 PDF rendering with @react-pdf/renderer. Uses only the built-in PDF base-14 Helvetica
 * fonts, so rendering never fetches fonts or anything else from the network. Written with
 * createElement rather than JSX so the package needs no JSX build configuration.
 */

const colours = { ink: '#1f2933', muted: '#52606d', rule: '#cbd2d9', band: '#f0f4f8' };

const styles = StyleSheet.create({
  page: {
    paddingTop: 40,
    paddingBottom: 56,
    paddingHorizontal: 44,
    fontFamily: 'Helvetica',
    fontSize: 9.5,
    color: colours.ink,
    lineHeight: 1.35,
  },
  header: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 20 },
  businessName: { fontFamily: 'Helvetica-Bold', fontSize: 15, marginBottom: 4, lineHeight: 1.2 },
  plain: {},
  muted: { color: colours.muted },
  titleBlock: { alignItems: 'flex-end' },
  title: { fontFamily: 'Helvetica-Bold', fontSize: 20, marginBottom: 6, lineHeight: 1.2 },
  bold: { fontFamily: 'Helvetica-Bold' },
  parties: { flexDirection: 'row', marginBottom: 18 },
  party: { flex: 1, paddingRight: 12 },
  label: {
    fontFamily: 'Helvetica-Bold',
    fontSize: 8,
    color: colours.muted,
    textTransform: 'uppercase',
    marginBottom: 3,
  },
  tableHead: {
    flexDirection: 'row',
    backgroundColor: colours.band,
    borderBottomWidth: 1,
    borderBottomColor: colours.rule,
    paddingVertical: 5,
    paddingHorizontal: 4,
    fontFamily: 'Helvetica-Bold',
    fontSize: 8.5,
  },
  row: {
    flexDirection: 'row',
    borderBottomWidth: 0.5,
    borderBottomColor: colours.rule,
    paddingVertical: 5,
    paddingHorizontal: 4,
  },
  description: { flex: 1, paddingRight: 8 },
  quantity: { width: 52, textAlign: 'right' },
  unit: { width: 36, paddingLeft: 6 },
  unitPrice: { width: 72, textAlign: 'right' },
  amount: { width: 84, textAlign: 'right' },
  totals: { marginTop: 10, alignSelf: 'flex-end', width: 240 },
  totalRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 3 },
  grandTotal: {
    borderTopWidth: 1,
    borderTopColor: colours.ink,
    marginTop: 3,
    paddingTop: 5,
    fontFamily: 'Helvetica-Bold',
    fontSize: 11,
  },
  notes: { marginTop: 22 },
  note: { marginBottom: 4 },
  acceptance: {
    marginTop: 16,
    padding: 10,
    borderWidth: 1,
    borderColor: colours.rule,
  },
  signature: { flexDirection: 'row', marginTop: 22 },
  signatureLine: {
    flex: 1,
    borderTopWidth: 0.5,
    borderTopColor: colours.muted,
    paddingTop: 3,
    marginRight: 16,
    fontSize: 8,
    color: colours.muted,
  },
  footer: {
    position: 'absolute',
    bottom: 28,
    left: 44,
    right: 44,
    fontSize: 8,
    color: colours.muted,
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
});

const text = (style: (typeof styles)[keyof typeof styles], ...children: ReactNode[]) =>
  h(Text, { style }, ...children);

function header(model: DocumentModel): ReactElement {
  return h(
    View,
    { style: styles.header },
    h(
      View,
      null,
      text(styles.businessName, model.business.name),
      ...(model.business.gstNumberLabel ? [text(styles.muted, model.business.gstNumberLabel)] : []),
      ...model.business.contactLines.map((line) => text(styles.muted, line)),
    ),
    h(
      View,
      { style: styles.titleBlock },
      text(styles.title, model.title),
      text(styles.bold, model.number),
      ...(model.versionLabel ? [text(styles.muted, model.versionLabel)] : []),
      ...model.dates.map((date) => text(styles.plain, `${date.label}: ${date.value}`)),
    ),
  );
}

function parties(model: DocumentModel): ReactElement {
  return h(
    View,
    { style: styles.parties },
    h(
      View,
      { style: styles.party },
      text(styles.label, model.kind === 'quote' ? 'Prepared for' : 'Bill to'),
      text(styles.bold, model.customer.name),
      ...model.customer.contactLines.map((line) => text(styles.plain, line)),
    ),
    ...(model.siteLabel
      ? [
          h(
            View,
            { style: styles.party },
            text(styles.label, 'Site'),
            text(styles.plain, model.siteLabel),
          ),
        ]
      : []),
  );
}

function table(model: DocumentModel): ReactElement {
  return h(
    View,
    null,
    h(
      View,
      { style: styles.tableHead, fixed: true },
      text(styles.description, 'Description'),
      text(styles.quantity, 'Qty'),
      text(styles.unit, 'Unit'),
      text(styles.unitPrice, 'Unit price'),
      text(styles.amount, model.amountColumnLabel),
    ),
    ...model.lines.map((line) =>
      h(
        View,
        { style: styles.row, wrap: false },
        text(styles.description, line.description),
        text(styles.quantity, line.quantity),
        text(styles.unit, line.unit),
        text(styles.unitPrice, line.unitPrice),
        text(styles.amount, line.amount),
      ),
    ),
  );
}

function totals(model: DocumentModel): ReactElement {
  return h(
    View,
    { style: styles.totals, wrap: false },
    ...model.totals.map((row) =>
      h(
        View,
        { style: row.emphasis ? [styles.totalRow, styles.grandTotal] : styles.totalRow },
        text(styles.plain, row.label),
        text(styles.plain, row.value),
      ),
    ),
  );
}

function footer(model: DocumentModel): ReactElement {
  return h(
    View,
    { style: styles.footer, fixed: true },
    text(styles.plain, `${model.business.name} · ${model.title} ${model.number}`),
    h(Text, {
      render: ({ pageNumber, totalPages }: { pageNumber: number; totalPages: number }) =>
        `Page ${pageNumber} of ${totalPages}`,
    }),
  );
}

export function documentElement(model: DocumentModel): ReactElement {
  const acceptance = model.acceptanceNote
    ? [
        h(
          View,
          { style: styles.acceptance, wrap: false },
          text(styles.bold, 'Acceptance'),
          text(styles.plain, model.acceptanceNote),
          h(
            View,
            { style: styles.signature },
            text(styles.signatureLine, 'Name'),
            text(styles.signatureLine, 'Signature'),
            text(styles.signatureLine, 'Date'),
          ),
        ),
      ]
    : [];
  return h(
    Document,
    {
      title: `${model.title} ${model.number}`,
      author: model.business.name,
      creator: 'OPENTRADIE',
      producer: 'OPENTRADIE',
    },
    h(
      Page,
      { size: 'A4', style: styles.page },
      header(model),
      parties(model),
      table(model),
      totals(model),
      h(View, { style: styles.notes }, ...model.notes.map((note) => text(styles.note, note))),
      ...acceptance,
      footer(model),
    ),
  );
}

export class DocumentIncompleteError extends Error {
  constructor(readonly missing: string[]) {
    super(`The document is missing required information: ${missing.join('; ')}.`);
    this.name = 'DocumentIncompleteError';
  }
}

export async function renderQuotePdf(model: DocumentModel): Promise<Buffer> {
  if (model.kind !== 'quote') throw new TypeError('renderQuotePdf needs a quote model.');
  return renderToBuffer(documentElement(model) as Parameters<typeof renderToBuffer>[0]);
}

/**
 * Render an invoice. Refuses when the taxable supply information check reports missing
 * fields or problems, so an incomplete tax invoice is never produced silently.
 */
export async function renderInvoicePdf(model: DocumentModel): Promise<Buffer> {
  if (model.kind !== 'invoice') throw new TypeError('renderInvoicePdf needs an invoice model.');
  const check = model.taxableSupply;
  if (check && (check.missing.length > 0 || check.problems.length > 0))
    throw new DocumentIncompleteError([...check.missing, ...check.problems]);
  return renderToBuffer(documentElement(model) as Parameters<typeof renderToBuffer>[0]);
}
