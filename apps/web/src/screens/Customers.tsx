import { useState } from 'react';
import type { FormEvent } from 'react';
import {
  createCustomer,
  createProperty,
  customerExportUrl,
  customerExportZipUrl,
  eraseCustomer,
  updateCustomer,
} from '../api';
import { Icon } from '../components/Icons';
import { CustomerRow, JobRow, QuoteRow } from '../components/rows';
import {
  Button,
  Dialog,
  Empty,
  ErrorNotice,
  LinkButton,
  PageHeader,
  Section,
  TextField,
  ViewOnlyNote,
} from '../components/ui';
import { formatDate, initials } from '../format';
import { href, navigate } from '../router';
import type { Customer, CustomerInput, PropertyInput } from '../types';
import { useWorkspace } from '../workspace';

export function CustomersScreen({ segments }: { segments: string[] }) {
  const { state } = useWorkspace();
  const [first, second] = segments;
  if (first === 'new') return <CustomerForm />;
  if (first) {
    const customer = state.customers.find((entry) => entry.id === first);
    if (!customer) return <NotFound />;
    return second === 'edit' ? (
      <CustomerForm key={customer.id} customer={customer} />
    ) : (
      <CustomerProfile customer={customer} />
    );
  }
  return <CustomerList />;
}

function NotFound() {
  return (
    <div className="stack">
      <PageHeader
        title="Customer not found"
        back={{ href: href('customers'), label: 'Customers' }}
      />
      <Empty icon="customers" title="This customer isn’t in your workspace">
        It may have been removed, or the link is wrong.
      </Empty>
    </div>
  );
}

function CustomerList() {
  const { state, isOwner } = useWorkspace();
  const [query, setQuery] = useState('');
  const needle = query.trim().toLocaleLowerCase('en-NZ');
  const filtered = needle
    ? state.customers.filter((customer) =>
        [customer.name, customer.email, customer.phone].some((value) =>
          value?.toLocaleLowerCase('en-NZ').includes(needle),
        ),
      )
    : state.customers;

  return (
    <div className="stack">
      <PageHeader
        title="Customers"
        eyebrow={`${state.customers.length} on file`}
        actions={
          isOwner ? (
            <LinkButton href={href('customers', 'new')} variant="primary" icon="plus">
              Add
            </LinkButton>
          ) : undefined
        }
      />
      <div className="search">
        <Icon name="search" />
        <label htmlFor="customer-search" className="sr-only">
          Search customers
        </label>
        <input
          id="customer-search"
          type="search"
          placeholder="Search name, phone or email"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          autoComplete="off"
        />
      </div>
      <p className="sr-only" aria-live="polite">
        {filtered.length} customers shown
      </p>
      {filtered.length ? (
        <ul className="rows card">
          {filtered.map((customer) => (
            <CustomerRow key={customer.id} customer={customer} />
          ))}
        </ul>
      ) : (
        <Empty
          icon="customers"
          title={needle ? 'No customers match' : 'No customers yet'}
          action={
            isOwner ? (
              <LinkButton href={href('customers', 'new')} icon="plus">
                Add a customer
              </LinkButton>
            ) : undefined
          }
        >
          {needle ? 'Try a different name, phone number or email.' : undefined}
        </Empty>
      )}
      {!isOwner && <ViewOnlyNote />}
    </div>
  );
}

function CustomerProfile({ customer }: { customer: Customer }) {
  const { state, isOwner } = useWorkspace();
  const jobs = state.jobs.filter((job) => job.customerId === customer.id);
  const quotes = state.quotes.filter((quote) => quote.customerId === customer.id);
  const enquiries = state.communications.filter((entry) => entry.customerId === customer.id);
  const notes = jobs.filter((job) => job.notes);
  const properties = (state.properties ?? []).filter(
    (property) => property.customerId === customer.id,
  );
  const [addingProperty, setAddingProperty] = useState(false);

  return (
    <div className="stack">
      <PageHeader
        title={customer.name}
        eyebrow="Customer"
        back={{ href: href('customers'), label: 'Customers' }}
        actions={
          isOwner ? (
            <LinkButton href={href('customers', customer.id, 'edit')} icon="edit">
              Edit
            </LinkButton>
          ) : undefined
        }
      />
      <section className="card card-pad profile-card" aria-label="Contact details">
        <span className="avatar avatar-lg" aria-hidden="true">
          {initials(customer.name)}
        </span>
        <div className="grid gap-2 min-w-0">
          {customer.phone ? (
            <a className="contact" href={`tel:${customer.phone.replace(/\s+/g, '')}`}>
              <Icon name="phone" /> {customer.phone}
            </a>
          ) : (
            <span className="muted">No phone recorded</span>
          )}
          {customer.email ? (
            <a className="contact" href={`mailto:${customer.email}`}>
              <Icon name="mail" /> {customer.email}
            </a>
          ) : (
            <span className="muted">No email recorded</span>
          )}
        </div>
      </section>

      <Section
        title="Properties"
        count={properties.length}
        action={
          isOwner && !addingProperty ? (
            <Button icon="plus" variant="quiet" onClick={() => setAddingProperty(true)}>
              Add property
            </Button>
          ) : undefined
        }
      >
        {addingProperty && (
          <PropertyForm customerId={customer.id} onDone={() => setAddingProperty(false)} />
        )}
        {properties.length ? (
          <ul className="notes" aria-label="Properties">
            {properties.map((property) => (
              <li key={property.id} className="property">
                <p className="row-title">{property.label ?? 'Property'}</p>
                <p className="note-text">{property.address}</p>
                {property.accessNotes && <p className="row-sub">Access: {property.accessNotes}</p>}
                {isOwner && (
                  <a
                    className="text-link"
                    href={`${href('jobs', 'new')}?customer=${encodeURIComponent(customer.id)}&property=${encodeURIComponent(property.id)}`}
                  >
                    New job here
                  </a>
                )}
              </li>
            ))}
          </ul>
        ) : (
          !addingProperty && (
            <Empty icon="home" title="No properties yet">
              Add the addresses you work at for this customer.
            </Empty>
          )
        )}
      </Section>

      <Section
        title="Jobs"
        count={jobs.length}
        action={
          isOwner ? (
            <LinkButton
              href={`${href('jobs', 'new')}?customer=${encodeURIComponent(customer.id)}`}
              icon="plus"
              variant="quiet"
            >
              New job
            </LinkButton>
          ) : undefined
        }
      >
        {jobs.length ? (
          <ul className="rows">
            {jobs.map((job) => (
              <JobRow key={job.id} job={job} showCustomer={false} />
            ))}
          </ul>
        ) : (
          <Empty icon="jobs" title="No jobs yet" />
        )}
      </Section>

      <Section title="Notes" count={notes.length}>
        {notes.length ? (
          <ul className="notes">
            {notes.map((job) => (
              <li key={job.id}>
                <p className="row-sub">
                  From job:{' '}
                  <a className="text-link" href={href('jobs', job.id)}>
                    {job.title}
                  </a>
                </p>
                <p className="note-text">{job.notes}</p>
              </li>
            ))}
          </ul>
        ) : (
          <Empty icon="file" title="No notes yet">
            Notes added to this customer’s jobs show here.
          </Empty>
        )}
      </Section>

      <Section title="Quotes" count={quotes.length}>
        {quotes.length ? (
          <ul className="rows">
            {quotes.map((quote) => (
              <QuoteRow key={quote.id} quote={quote} showCustomer={false} />
            ))}
          </ul>
        ) : (
          <Empty icon="quotes" title="No quotes yet" />
        )}
      </Section>

      <Section title="Enquiries" count={enquiries.length}>
        {enquiries.length ? (
          <ul className="notes">
            {enquiries.map((entry) => (
              <li key={entry.id}>
                <p className="row-sub">
                  <time dateTime={entry.createdAt}>
                    {formatDate(entry.createdAt, state.business.timeZone)}
                  </time>{' '}
                  · customer supplied
                </p>
                <p className="note-text">{entry.text}</p>
              </li>
            ))}
          </ul>
        ) : (
          <Empty icon="mail" title="No enquiries linked" />
        )}
      </Section>

      {isOwner && <CustomerPrivacy customer={customer} />}
    </div>
  );
}

/** Owner-only privacy actions: export everything held about this customer, or erase it. */
function CustomerPrivacy({ customer }: { customer: Customer }) {
  const { reload } = useWorkspace();
  const [confirming, setConfirming] = useState(false);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function erase(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await eraseCustomer(customer.id, typed);
      setConfirming(false);
      // Erased customers are archived, so they leave the list.
      await reload();
      navigate(href('customers'));
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section title="Privacy">
      <p className="row-sub">
        Export a copy of everything held about this customer, or erase their personal details.
        Invoices and accepted quotes are kept for tax records with the name removed.
      </p>
      <div className="privacy-actions">
        <a className="btn btn-secondary" href={customerExportUrl(customer.id)} download>
          <Icon name="file" />
          <span>Export customer data</span>
        </a>
        <a className="btn btn-secondary" href={customerExportZipUrl(customer.id)} download>
          <Icon name="file" />
          <span>Download with files (.zip)</span>
        </a>
        <Button variant="stop" onClick={() => setConfirming(true)}>
          Erase customer
        </Button>
      </div>
      {confirming && (
        <Dialog title="Erase this customer?" onClose={() => setConfirming(false)}>
          <form className="form" onSubmit={(event) => void erase(event)}>
            <p>
              This removes their contact details, addresses, messages, notes, voice transcripts,
              photos and attachments. It cannot be undone.
            </p>
            {error !== null && <ErrorNotice title="Customer not erased" error={error} />}
            <TextField
              label={`Type "${customer.name}" to confirm`}
              name="confirmName"
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              autoComplete="off"
              required
            />
            <Button
              type="submit"
              variant="stop"
              busy={busy}
              disabled={typed.trim() !== customer.name.trim() || busy}
            >
              Erase customer
            </Button>
          </form>
        </Dialog>
      )}
    </Section>
  );
}

function PropertyForm({ customerId, onDone }: { customerId: string; onDone: () => void }) {
  const { reload } = useWorkspace();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const value = (key: string) => String(form.get(key) ?? '').trim();
    const input: PropertyInput = { addressLine1: value('addressLine1') };
    for (const key of ['label', 'suburb', 'city', 'postcode', 'accessNotes'] as const)
      if (value(key)) input[key] = value(key);
    setBusy(true);
    setError(null);
    try {
      await createProperty(customerId, input);
      await reload();
      onDone();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <form
      className="form property-form"
      aria-label="Add property"
      onSubmit={(event) => void submit(event)}
    >
      {error !== null && <ErrorNotice title="Property not saved" error={error} />}
      <TextField
        label="Street address"
        name="addressLine1"
        required
        maxLength={200}
        autoComplete="off"
      />
      <div className="grid-2">
        <TextField label="Suburb" name="suburb" optional maxLength={100} autoComplete="off" />
        <TextField label="City" name="city" optional maxLength={100} autoComplete="off" />
      </div>
      <div className="grid-2">
        <TextField
          label="Postcode"
          name="postcode"
          optional
          inputMode="numeric"
          maxLength={12}
          autoComplete="off"
        />
        <TextField
          label="Label"
          name="label"
          optional
          maxLength={100}
          placeholder="e.g. Home, Rental"
          autoComplete="off"
        />
      </div>
      <TextField
        label="Access notes"
        name="accessNotes"
        optional
        maxLength={2000}
        placeholder="Gate codes, pets, parking"
        autoComplete="off"
      />
      <div className="form-actions">
        <Button type="submit" variant="primary" icon="check" busy={busy} disabled={busy}>
          Save property
        </Button>
        <Button onClick={onDone} disabled={busy}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function CustomerForm({ customer }: { customer?: Customer }) {
  const { isOwner, reload } = useWorkspace();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const editing = Boolean(customer);
  const back = customer
    ? { href: href('customers', customer.id), label: customer.name }
    : { href: href('customers'), label: 'Customers' };

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const value = (key: string) => String(form.get(key) ?? '').trim();
    const input: CustomerInput = { name: value('name') };
    if (value('email')) input.email = value('email');
    if (value('phone')) input.phone = value('phone');
    setBusy(true);
    setError(null);
    try {
      const saved = customer
        ? await updateCustomer(customer.id, input)
        : await createCustomer(input);
      await reload();
      navigate(href('customers', saved.id ?? customer?.id ?? ''));
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      <PageHeader title={editing ? 'Edit customer' : 'New customer'} back={back} />
      {!isOwner ? (
        <ViewOnlyNote />
      ) : (
        <form className="card card-pad form" onSubmit={(event) => void submit(event)}>
          {error !== null && <ErrorNotice title="Customer not saved" error={error} />}
          <TextField
            label="Name"
            name="name"
            required
            maxLength={200}
            defaultValue={customer?.name}
            autoComplete="off"
          />
          <TextField
            label="Mobile or phone"
            name="phone"
            optional
            type="tel"
            inputMode="tel"
            minLength={3}
            maxLength={50}
            defaultValue={customer?.phone ?? ''}
            autoComplete="off"
          />
          <TextField
            label="Email"
            name="email"
            optional
            type="email"
            inputMode="email"
            maxLength={254}
            defaultValue={customer?.email ?? ''}
            autoComplete="off"
          />
          <div className="form-actions">
            <Button type="submit" variant="primary" icon="check" busy={busy} disabled={busy}>
              {editing ? 'Save changes' : 'Add customer'}
            </Button>
            <LinkButton href={back.href}>Cancel</LinkButton>
          </div>
        </form>
      )}
    </div>
  );
}
