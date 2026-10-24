import { useEffect, useMemo, useState } from 'react';
import {
  customerReportCsvUrl,
  formatPercent,
  getCustomerReport,
  reportQuery,
  type CustomerReport,
  type CustomerReportRow,
  type ReportPeriod,
} from '../crm-api';
import {
  Empty,
  ErrorNotice,
  Loading,
  PageHeader,
  Section,
  SelectField,
  TextField,
} from '../components/ui';
import { formatMoney } from '../format';
import { href } from '../router';

/**
 * Customers › Insights (ADR 0034): read-only customer report for a period. Every number is
 * integer cents computed by the server; revenue counts approved-or-later invoices, never
 * drafts or void ones.
 */
type SortKey =
  'name' | 'jobs' | 'invoicedInclCents' | 'paidCents' | 'outstandingCents' | 'winRateBp';
const COLUMNS: { key: SortKey; label: string; numeric: boolean }[] = [
  { key: 'name', label: 'Customer', numeric: false },
  { key: 'jobs', label: 'Jobs', numeric: true },
  { key: 'winRateBp', label: 'Quote win rate', numeric: true },
  { key: 'invoicedInclCents', label: 'Invoiced (incl. GST)', numeric: true },
  { key: 'paidCents', label: 'Paid', numeric: true },
  { key: 'outstandingCents', label: 'Outstanding', numeric: true },
];

function useReport(query: string) {
  const [report, setReport] = useState<CustomerReport | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    let live = true;
    setError(null);
    getCustomerReport(query)
      .then((result) => live && setReport(result))
      .catch((caught: unknown) => live && setError(caught));
    return () => {
      live = false;
    };
  }, [query]);
  return { report, error };
}

export function CustomerInsights() {
  const [period, setPeriod] = useState<ReportPeriod>('this_financial_year');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const query = reportQuery(period, from, to);
  const { report, error } = useReport(query);
  const [sort, setSort] = useState<{ key: SortKey; descending: boolean }>({
    key: 'invoicedInclCents',
    descending: true,
  });
  const rows = useMemo(() => {
    const list = [...(report?.rows ?? [])];
    list.sort((a, b) => {
      const x = a[sort.key] as number | string | null;
      const y = b[sort.key] as number | string | null;
      const order =
        typeof x === 'string' || typeof y === 'string'
          ? String(x).localeCompare(String(y))
          : (x ?? -1) - (y ?? -1);
      return sort.descending ? -order : order;
    });
    return list;
  }, [report, sort]);

  return (
    <div className="stack">
      <PageHeader
        title="Customer insights"
        back={{ href: href('customers'), label: 'Customers' }}
      />
      <section className="card card-pad stack" aria-label="Report period">
        <SelectField
          label="Period"
          value={period}
          onChange={(event) => setPeriod(event.target.value as ReportPeriod)}
        >
          <option value="this_month">This month</option>
          <option value="last_month">Last month</option>
          <option value="this_financial_year">This financial year (Apr–Mar)</option>
          <option value="custom">Custom dates</option>
        </SelectField>
        {period === 'custom' && (
          <div className="grid gap-2 sm:grid-cols-2">
            <TextField
              label="From"
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
            />
            <TextField label="To" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
        )}
        {report && (
          <p className="hint">
            {report.range.from} to {report.range.to}. Revenue counts approved, posted and paid
            invoices; drafts and void invoices are left out.
          </p>
        )}
      </section>
      {error !== null && <ErrorNotice title="Report not loaded" error={error} />}
      {!report && error === null && <Loading label="Loading report…" />}
      {report && (
        <>
          <ul className="tiles" aria-label="Summary">
            <Tile
              label="Invoiced (incl. GST)"
              value={formatMoney(report.summary.invoicedInclCents)}
            />
            <Tile label="Paid" value={formatMoney(report.summary.paidCents)} />
            <Tile label="Outstanding" value={formatMoney(report.summary.outstandingCents)} />
            <Tile label="Quote win rate" value={formatPercent(report.summary.winRateBp)} />
            <Tile
              label="New / repeat customers"
              value={`${report.summary.newCustomers} / ${report.summary.repeatCustomers}`}
            />
            <Tile
              label="Average days to pay"
              value={
                report.summary.averageDaysToPay === null
                  ? '—'
                  : String(report.summary.averageDaysToPay)
              }
            />
          </ul>
          {report.summary.topCustomers.length > 0 && (
            <Section title="Top customers by revenue">
              <ol className="rows">
                {report.summary.topCustomers.map((top) => (
                  <li key={top.customerId} className="row">
                    <a className="row-main" href={href('customers', top.customerId)}>
                      <span className="row-title">{top.name}</span>
                    </a>
                    <span className="row-meta">{formatMoney(top.invoicedInclCents)}</span>
                  </li>
                ))}
              </ol>
            </Section>
          )}
          <Section
            title="Customers"
            count={rows.length}
            action={
              <a className="btn btn-secondary" href={customerReportCsvUrl(query)} download>
                <span>Download CSV</span>
              </a>
            }
          >
            {rows.length ? (
              <div
                className="table-scroll"
                tabIndex={0}
                role="region"
                aria-label="Customer report table"
              >
                <table className="data-table">
                  <thead>
                    <tr>
                      {COLUMNS.map((column) => (
                        <th
                          key={column.key}
                          scope="col"
                          className={column.numeric ? 'num' : undefined}
                          aria-sort={
                            sort.key === column.key
                              ? sort.descending
                                ? 'descending'
                                : 'ascending'
                              : 'none'
                          }
                        >
                          <button
                            type="button"
                            className="sort-button"
                            onClick={() =>
                              setSort((current) => ({
                                key: column.key,
                                descending:
                                  current.key === column.key ? !current.descending : column.numeric,
                              }))
                            }
                          >
                            {column.label}
                          </button>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => (
                      <ReportRow key={row.customerId} row={row} />
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <Empty icon="customers" title="No customer activity in this period" />
            )}
          </Section>
        </>
      )}
    </div>
  );
}

function Tile({ label, value }: { label: string; value: string }) {
  return (
    <li className="tile card card-pad">
      <span className="tile-label">{label}</span>
      <span className="tile-value">{value}</span>
    </li>
  );
}

function ReportRow({ row }: { row: CustomerReportRow }) {
  return (
    <tr>
      <th scope="row">
        <a href={href('customers', row.customerId)}>{row.name}</a>
        {row.repeat && <span className="hint">Repeat customer</span>}
      </th>
      <td className="num">{row.jobs}</td>
      <td className="num">{formatPercent(row.winRateBp)}</td>
      <td className="num">{formatMoney(row.invoicedInclCents)}</td>
      <td className="num">{formatMoney(row.paidCents)}</td>
      <td className="num">{formatMoney(row.outstandingCents)}</td>
    </tr>
  );
}

/** Per-customer stats on the profile: this financial year. */
export function CustomerStats({ customerId }: { customerId: string }) {
  const { report, error } = useReport('period=this_financial_year');
  if (error !== null) return null;
  const row = report?.rows.find((entry) => entry.customerId === customerId);
  return (
    <Section title="This financial year">
      {!report ? (
        <Loading label="Loading stats…" />
      ) : row ? (
        <dl className="stats">
          <div>
            <dt>Invoiced (incl. GST)</dt>
            <dd>{formatMoney(row.invoicedInclCents)}</dd>
          </div>
          <div>
            <dt>Paid</dt>
            <dd>{formatMoney(row.paidCents)}</dd>
          </div>
          <div>
            <dt>Outstanding</dt>
            <dd>{formatMoney(row.outstandingCents)}</dd>
          </div>
          <div>
            <dt>Quotes won</dt>
            <dd>
              {row.quotesAccepted} of {row.quotesSent}
            </dd>
          </div>
          <div>
            <dt>Jobs</dt>
            <dd>{row.jobs}</dd>
          </div>
          <div>
            <dt>Repeat customer</dt>
            <dd>{row.repeat ? 'Yes' : 'No'}</dd>
          </div>
        </dl>
      ) : (
        <p className="hint">No activity this financial year.</p>
      )}
    </Section>
  );
}
