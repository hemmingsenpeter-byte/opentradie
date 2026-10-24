import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import {
  dismissDuplicate,
  listDuplicates,
  mergeCustomer,
  mergePreview,
  type DuplicateCustomer,
  type DuplicatePair,
  type DuplicateReason,
  type MergePreview,
} from '../crm-api';
import {
  Button,
  Empty,
  ErrorNotice,
  Loading,
  Notice,
  PageHeader,
  Section,
  TextField,
  ViewOnlyNote,
} from '../components/ui';
import { href, navigate } from '../router';
import { useWorkspace } from '../workspace';

/**
 * Customers › Possible duplicates (ADR 0034). Review a pair side by side, then merge (type the
 * surviving customer's name to confirm) or mark it as not a duplicate.
 */
const REASONS: Record<DuplicateReason, string> = {
  email: 'Same email',
  phone: 'Same phone number',
  name_and_address: 'Similar name at the same address',
  similar_name: 'Same name',
};
const TABLE_LABELS: Record<string, string> = {
  jobs: 'Jobs',
  quotes: 'Quotes',
  invoices: 'Invoices',
  properties: 'Properties',
  customer_contacts: 'Contacts',
  communications: 'Messages',
  communication_threads: 'Conversations',
  tasks: 'Tasks',
  reminders: 'Reminders',
  documents: 'Documents',
  voice_notes: 'Voice notes',
  knowledge_items: 'Knowledge items',
  action_proposals: 'Proposals',
  automation_runs: 'Automation runs',
  customer_tags: 'Tags',
};

export function CustomerDuplicates() {
  const { isOwner } = useWorkspace();
  const [pairs, setPairs] = useState<DuplicatePair[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [reviewing, setReviewing] = useState<DuplicatePair | null>(null);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    let live = true;
    listDuplicates()
      .then((result) => live && setPairs(result.pairs))
      .catch((caught: unknown) => live && setError(caught));
    return () => {
      live = false;
    };
  }, [version]);

  if (reviewing)
    return (
      <ReviewPair
        pair={reviewing}
        canEdit={isOwner}
        onDone={() => {
          setReviewing(null);
          setVersion((value) => value + 1);
        }}
      />
    );
  return (
    <div className="stack">
      <PageHeader
        title="Possible duplicates"
        back={{ href: href('customers'), label: 'Customers' }}
      />
      {error !== null && <ErrorNotice title="Duplicates not loaded" error={error} />}
      {!pairs && error === null && <Loading />}
      {pairs && !pairs.length && (
        <Empty icon="customers" title="No possible duplicates">
          Customers with the same email, phone number, or a similar name at the same address show up
          here.
        </Empty>
      )}
      {pairs && pairs.length > 0 && (
        <ul className="rows card" aria-label="Possible duplicate pairs">
          {pairs.map((pair) => (
            <li key={`${pair.customers[0].id}:${pair.customers[1].id}`} className="row">
              <span className="row-main">
                <span className="row-title">
                  {pair.customers[0].name} and {pair.customers[1].name}
                </span>
                <span className="row-sub">
                  {pair.reasons.map((reason) => REASONS[reason]).join(', ')}
                </span>
              </span>
              <Button onClick={() => setReviewing(pair)}>
                Review
                <span className="sr-only">{` ${pair.customers[0].name} and ${pair.customers[1].name}`}</span>
              </Button>
            </li>
          ))}
        </ul>
      )}
      {!isOwner && <ViewOnlyNote />}
    </div>
  );
}

function ReviewPair({
  pair,
  canEdit,
  onDone,
}: {
  pair: DuplicatePair;
  canEdit: boolean;
  onDone: () => void;
}) {
  const { reload } = useWorkspace();
  const [keep, setKeep] = useState(pair.customers[0].id);
  const survivor = pair.customers.find((customer) => customer.id === keep)!;
  const merged = pair.customers.find((customer) => customer.id !== keep)!;
  const [preview, setPreview] = useState<MergePreview | null>(null);
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    setPreview(null);
    mergePreview(merged.id, survivor.id)
      .then((result) => live && setPreview(result))
      .catch((caught: unknown) => live && setError(caught));
    return () => {
      live = false;
    };
  }, [merged.id, survivor.id]);

  async function merge(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await mergeCustomer(merged.id, survivor.id, confirm);
      await reload();
      navigate(href('customers', survivor.id));
    } catch (caught) {
      setError(caught);
      setBusy(false);
    }
  }

  async function notDuplicate() {
    setBusy(true);
    try {
      await dismissDuplicate(pair.customers[0].id, pair.customers[1].id);
      onDone();
    } catch (caught) {
      setError(caught);
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      <PageHeader
        title="Compare customers"
        back={{ href: href('customers', 'duplicates'), label: 'Possible duplicates' }}
      />
      <p className="hint">{pair.reasons.map((reason) => REASONS[reason]).join(', ')}.</p>
      <div className="compare" role="group" aria-label="Customers side by side">
        {pair.customers.map((customer) => (
          <CompareCard
            key={customer.id}
            customer={customer}
            keep={customer.id === keep}
            canEdit={canEdit}
            onKeep={() => setKeep(customer.id)}
          />
        ))}
      </div>
      {error !== null && <ErrorNotice title="Not merged" error={error} />}
      {preview && (
        <Section title={`Merging ${merged.name} into ${survivor.name}`}>
          <ul className="plain-list">
            {Object.entries(preview.moves).map(([table, count]) => (
              <li key={table}>
                {TABLE_LABELS[table] ?? table}: {count} move
              </li>
            ))}
            {preview.duplicatePropertiesArchived > 0 && (
              <li>{preview.duplicatePropertiesArchived} identical address(es) combined</li>
            )}
            {!Object.keys(preview.moves).length && <li>Nothing else to move.</li>}
          </ul>
          {preview.warnings.map((warning) => (
            <Notice key={warning.code} tone="warning" title="Check your accounting system">
              {warning.message}
            </Notice>
          ))}
        </Section>
      )}
      {canEdit && (
        <form className="card card-pad stack" onSubmit={merge}>
          <TextField
            label={`Type "${survivor.name}" to confirm the merge`}
            value={confirm}
            onChange={(event) => setConfirm(event.target.value)}
            autoComplete="off"
          />
          <Button
            type="submit"
            variant="primary"
            busy={busy}
            disabled={
              busy ||
              confirm.trim().toLocaleLowerCase('en-NZ') !==
                survivor.name.trim().toLocaleLowerCase('en-NZ')
            }
          >
            Merge into {survivor.name}
          </Button>
          <Button variant="quiet" onClick={notDuplicate} disabled={busy}>
            Not a duplicate
          </Button>
        </form>
      )}
    </div>
  );
}

function CompareCard({
  customer,
  keep,
  canEdit,
  onKeep,
}: {
  customer: DuplicateCustomer;
  keep: boolean;
  canEdit: boolean;
  onKeep: () => void;
}) {
  return (
    <section
      className={`card card-pad stack ${keep ? 'compare-keep' : ''}`}
      aria-label={customer.name}
    >
      <h2 className="section-title">{customer.name}</h2>
      <dl className="stats">
        <div>
          <dt>Email</dt>
          <dd>{customer.email ?? '—'}</dd>
        </div>
        <div>
          <dt>Phone</dt>
          <dd>{customer.phone ?? '—'}</dd>
        </div>
        <div>
          <dt>Address</dt>
          <dd>{customer.address ?? '—'}</dd>
        </div>
        <div>
          <dt>Jobs</dt>
          <dd>{customer.jobCount}</dd>
        </div>
      </dl>
      {canEdit && (
        <label className="tag-option">
          <input type="radio" name="keep" checked={keep} onChange={onKeep} /> Keep this customer
        </label>
      )}
    </section>
  );
}
