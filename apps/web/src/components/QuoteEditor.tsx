import { useState } from 'react';
import { ApiError, newIdempotencyKey, updateQuoteLines } from '../api';
import {
  basisPointsToText,
  centsToText,
  milliToText,
  parseCents,
  parsePercentBasisPoints,
  parseQuantityMilli,
} from '../format';
import type { LineKind, LineUnit, Quote, QuoteLineRequest, TaxCode } from '../types';
import { LINE_UNITS } from '../types';
import { useWorkspace } from '../workspace';
import { Button, ErrorNotice } from './ui';

/**
 * Owner editor for draft quote lines. Inputs are strings parsed exactly (no floating point);
 * the server prices every line and returns the totals shown in the totals panel.
 */
type Mode = 'rate' | 'cost' | 'price';

interface Row {
  key: string;
  mode: Mode;
  kind: LineKind;
  rateCode: string;
  description: string;
  unit: LineUnit;
  quantity: string;
  cost: string;
  markup: string;
  price: string;
  taxCode: TaxCode;
  discount: string;
}

const UNIT_LABEL: Record<LineUnit, string> = {
  each: 'each',
  hour: 'hour',
  visit: 'visit',
  metre: 'metre',
  square_metre: 'm²',
  litre: 'litre',
  kilogram: 'kg',
};

function rowsFrom(quote: Quote, defaultRate: string): Row[] {
  return quote.lines.map((line, index) => {
    const mode: Mode =
      line.priceSource === 'cost_plus_markup'
        ? 'cost'
        : line.priceSource === 'owner_entered'
          ? 'price'
          : 'rate';
    return {
      key: `${index}-${line.description}`,
      mode,
      kind: line.kind ?? 'labour',
      rateCode: line.rateCode ?? defaultRate,
      description: line.description,
      unit: line.unit ?? 'each',
      quantity: milliToText(line.quantityMilli ?? line.quantity * 1000),
      cost: line.costCents != null ? centsToText(line.costCents) : '',
      markup: line.markupBasisPoints != null ? basisPointsToText(line.markupBasisPoints) : '',
      price: centsToText(line.unitPriceCents),
      taxCode: line.taxCode ?? 'standard',
      discount: line.discountBasisPoints ? basisPointsToText(line.discountBasisPoints) : '',
    };
  });
}

function toRequest(row: Row, index: number): QuoteLineRequest | string {
  const label = `Line ${index + 1}`;
  const quantityMilli = parseQuantityMilli(row.quantity);
  if (!quantityMilli) return `${label}: enter a quantity such as 1 or 1.5.`;
  const discount = row.discount.trim() ? parsePercentBasisPoints(row.discount) : 0;
  if (discount === null || discount > 10_000) return `${label}: discount must be 0–100%.`;
  const shared = {
    quantityMilli,
    taxCode: row.taxCode,
    ...(discount ? { discountBasisPoints: discount } : {}),
  };
  if (row.mode === 'rate') {
    if (!row.rateCode) return `${label}: choose an approved rate.`;
    return {
      source: 'approved_rate',
      rateCode: row.rateCode,
      ...(row.kind !== 'discount' ? { kind: row.kind } : {}),
      ...shared,
    };
  }
  if (!row.description.trim()) return `${label}: add a description.`;
  if (row.mode === 'cost') {
    const costCents = parseCents(row.cost);
    if (costCents === null) return `${label}: enter the cost, e.g. 12.50.`;
    const markup = row.markup.trim() ? parsePercentBasisPoints(row.markup) : undefined;
    if (markup === null) return `${label}: markup must be a percentage, e.g. 20.`;
    return {
      source: 'cost_plus_markup',
      description: row.description.trim(),
      unit: row.unit,
      costCents,
      ...(markup !== undefined ? { markupBasisPoints: markup } : {}),
      ...shared,
    };
  }
  const unitPriceCents = parseCents(row.price);
  if (unitPriceCents === null) return `${label}: enter the price, e.g. 85.00.`;
  return {
    source: 'owner_entered',
    kind: row.kind,
    description: row.description.trim(),
    unit: row.unit,
    unitPriceCents,
    ...shared,
  };
}

export function QuoteEditor({ quote, onSaved }: { quote: Quote; onSaved?: () => void }) {
  const { state, reload } = useWorkspace();
  const firstRate = state.rates[0]?.code ?? '';
  const [rows, setRows] = useState<Row[]>(() => rowsFrom(quote, firstRate));
  const [key, setKey] = useState(newIdempotencyKey);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const registered = quote.gstRegistered ?? true;

  const update = (index: number, patch: Partial<Row>) => {
    setRows((current) => current.map((row, i) => (i === index ? { ...row, ...patch } : row)));
    setKey(newIdempotencyKey());
  };
  const add = (mode: Mode) => {
    setRows((current) => [
      ...current,
      {
        key: newIdempotencyKey(),
        mode,
        kind: mode === 'cost' ? 'material' : mode === 'rate' ? 'labour' : 'fee',
        rateCode: firstRate,
        description: '',
        unit: 'each',
        quantity: '1',
        cost: '',
        markup: '',
        price: '',
        taxCode: 'standard',
        discount: '',
      },
    ]);
    setKey(newIdempotencyKey());
  };

  async function save() {
    setProblem(null);
    setError(null);
    const requests = rows.map(toRequest);
    const invalid = requests.find((entry): entry is string => typeof entry === 'string');
    if (invalid) return setProblem(invalid);
    if (!requests.length) return setProblem('A quote needs at least one line.');
    setBusy(true);
    try {
      await updateQuoteLines(quote.id, quote.version, requests as QuoteLineRequest[], key);
      await reload();
      onSaved?.();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-4" data-testid="quote-editor">
      {rows.map((row, index) => (
        <fieldset
          key={row.key}
          className="card card-pad grid gap-3"
          aria-label={`Line ${index + 1}`}
        >
          <div className="flex flex-wrap gap-3">
            <label className="field">
              <span>Price from</span>
              <select
                value={row.mode}
                onChange={(event) => update(index, { mode: event.target.value as Mode })}
              >
                <option value="rate">Approved rate</option>
                <option value="cost">Material cost + markup</option>
                <option value="price">My price</option>
              </select>
            </label>
            {row.mode === 'rate' ? (
              <label className="field">
                <span>Rate</span>
                <select
                  value={row.rateCode}
                  onChange={(event) => update(index, { rateCode: event.target.value })}
                >
                  {state.rates.map((rate) => (
                    <option key={rate.code} value={rate.code}>
                      {rate.label}
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              <label className="field flex-1">
                <span>Description</span>
                <input
                  value={row.description}
                  maxLength={300}
                  onChange={(event) => update(index, { description: event.target.value })}
                />
              </label>
            )}
          </div>
          <div className="flex flex-wrap gap-3">
            {row.mode !== 'cost' && (
              <label className="field">
                <span>Kind</span>
                <select
                  value={row.kind}
                  onChange={(event) => update(index, { kind: event.target.value as LineKind })}
                >
                  <option value="labour">Labour</option>
                  <option value="material">Material</option>
                  <option value="fee">Fee</option>
                  {row.mode === 'price' && <option value="discount">Discount</option>}
                </select>
              </label>
            )}
            <label className="field">
              <span>Quantity</span>
              <input
                inputMode="decimal"
                value={row.quantity}
                onChange={(event) => update(index, { quantity: event.target.value })}
              />
            </label>
            {row.mode !== 'rate' && (
              <label className="field">
                <span>Unit</span>
                <select
                  value={row.unit}
                  onChange={(event) => update(index, { unit: event.target.value as LineUnit })}
                >
                  {LINE_UNITS.map((unit) => (
                    <option key={unit} value={unit}>
                      {UNIT_LABEL[unit]}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {row.mode === 'cost' && (
              <>
                <label className="field">
                  <span>Cost each ($)</span>
                  <input
                    inputMode="decimal"
                    value={row.cost}
                    onChange={(event) => update(index, { cost: event.target.value })}
                  />
                </label>
                <label className="field">
                  <span>Markup (%)</span>
                  <input
                    inputMode="decimal"
                    placeholder="default"
                    value={row.markup}
                    onChange={(event) => update(index, { markup: event.target.value })}
                  />
                </label>
              </>
            )}
            {row.mode === 'price' && (
              <label className="field">
                <span>Price each ($)</span>
                <input
                  inputMode="decimal"
                  value={row.price}
                  onChange={(event) => update(index, { price: event.target.value })}
                />
              </label>
            )}
            {registered && (
              <label className="field">
                <span>GST</span>
                <select
                  value={row.taxCode}
                  onChange={(event) => update(index, { taxCode: event.target.value as TaxCode })}
                >
                  <option value="standard">Standard</option>
                  <option value="zero_rated">Zero-rated</option>
                  <option value="exempt">Exempt</option>
                </select>
              </label>
            )}
            {row.kind !== 'discount' && (
              <label className="field">
                <span>Discount (%)</span>
                <input
                  inputMode="decimal"
                  value={row.discount}
                  onChange={(event) => update(index, { discount: event.target.value })}
                />
              </label>
            )}
          </div>
          <Button
            variant="quiet"
            icon="close"
            onClick={() => {
              setRows((current) => current.filter((_, i) => i !== index));
              setKey(newIdempotencyKey());
            }}
          >
            Remove line {index + 1}
          </Button>
        </fieldset>
      ))}
      <div className="flex flex-wrap gap-2">
        <Button icon="plus" onClick={() => add('rate')} disabled={!firstRate}>
          Add rate line
        </Button>
        <Button icon="plus" onClick={() => add('cost')}>
          Add material
        </Button>
        <Button icon="plus" onClick={() => add('price')}>
          Add my price
        </Button>
      </div>
      {problem && (
        <p className="field-error" role="alert">
          {problem}
        </p>
      )}
      {error !== null && (
        <ErrorNotice
          title={
            error instanceof ApiError && error.code === 'STALE_QUOTE'
              ? 'Quote changed'
              : 'Lines not saved'
          }
          error={error}
        />
      )}
      <Button
        variant="primary"
        icon="check"
        busy={busy}
        disabled={busy}
        onClick={() => void save()}
      >
        Save lines
      </Button>
    </div>
  );
}
