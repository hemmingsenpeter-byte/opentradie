import { useState } from 'react';
import type { FormEvent } from 'react';
import { createCustomer, updateCustomer } from '../api';
import { Icon } from '../components/Icons';
import { CustomerRow, JobRow, QuoteRow } from '../components/rows';
import {
  Button,
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
import type { Customer, CustomerInput } from '../types';
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
    </div>
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
