import { describe, expect, it } from 'vitest';
import { customerReportCsvUrl, reportQuery } from './crm-api';

describe('reportQuery', () => {
  it('uses a preset period unless both custom dates are valid', () => {
    expect(reportQuery('this_month')).toBe('period=this_month');
    expect(reportQuery('custom', '2026-04-01', '2027-03-31')).toBe('from=2026-04-01&to=2027-03-31');
    expect(reportQuery('custom', '2026-04-01', '')).toBe('period=this_month');
  });

  it('never puts other characters from the date inputs into the CSV link', () => {
    const query = reportQuery('custom', '2026-04-01&format=json', '"><script>');
    expect(query).toBe('period=this_month');
    expect(customerReportCsvUrl(query)).toBe('/api/reports/customers?period=this_month&format=csv');
  });
});
