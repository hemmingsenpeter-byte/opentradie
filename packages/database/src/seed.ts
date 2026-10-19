import { randomUUID } from 'node:crypto';
import { hashPassword } from '@opentradie/core';
import { transaction, type Database, type Transaction } from './db.js';

/** Synthetic sample rates, labelled as such. They are not market prices. */
export const DEMO_RATES = [
  {
    code: 'call_out',
    label: 'Call-out fee (per visit) · synthetic sample rate',
    unit: 'visit',
    unitPriceCents: 9_500,
  },
  {
    code: 'labour_hour',
    label: 'Electrician labour (per hour) · synthetic sample rate',
    unit: 'hour',
    unitPriceCents: 11_000,
  },
  {
    code: 'power_point_replace',
    label: 'Replace existing double power point, supply and install · synthetic sample rate',
    unit: 'each',
    unitPriceCents: 8_900,
  },
  {
    code: 'power_point_new',
    label: 'Install new double power point, standard cable run · synthetic sample rate',
    unit: 'each',
    unitPriceCents: 18_500,
  },
  {
    code: 'light_fitting_replace',
    label: 'Replace light fitting (customer supplied) · synthetic sample rate',
    unit: 'each',
    unitPriceCents: 7_500,
  },
] as const;

export interface SeedOptions {
  tenantId: string;
  ownerEmail: string;
  ownerPassword: string;
  viewerEmail?: string;
  viewerPassword?: string;
  businessName?: string;
  taxBasisPoints?: number;
}

/** Idempotent: an existing business is left untouched. All people, places and history are synthetic. */
export async function seed(db: Database, options: SeedOptions): Promise<{ created: boolean }> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(options.tenantId))
    throw new Error('TENANT_ID must be a UUID.');
  const taxBasisPoints = options.taxBasisPoints ?? 1500;
  if (!Number.isInteger(taxBasisPoints) || taxBasisPoints < 0 || taxBasisPoints > 10_000)
    throw new Error('Tax rate must be 0-10000 basis points.');
  const ownerHash = await hashPassword(options.ownerPassword);
  const viewerHash =
    options.viewerEmail && options.viewerPassword
      ? await hashPassword(options.viewerPassword)
      : null;
  return transaction(db, async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`seed:${options.tenantId}`]);
    const exists = await client.query('SELECT 1 FROM businesses WHERE id=$1', [options.tenantId]);
    if (exists.rowCount) return { created: false };
    const t = options.tenantId;
    await client.query(
      "INSERT INTO businesses(id,name,trade,tax_basis_points,call_out_rate_code,demo_data) VALUES($1,$2,'electrician',$3,'call_out',true)",
      [t, options.businessName ?? 'Harbourside Electrical (synthetic demo)', taxBasisPoints],
    );
    const ownerId = randomUUID();
    await client.query(
      "INSERT INTO users(id,tenant_id,email,display_name,password_hash,role) VALUES($1,$2,$3,'Demo Owner',$4,'owner')",
      [ownerId, t, options.ownerEmail.toLowerCase(), ownerHash],
    );
    if (options.viewerEmail && viewerHash) {
      await client.query(
        "INSERT INTO users(id,tenant_id,email,display_name,password_hash,role) VALUES($1,$2,$3,'Demo Viewer',$4,'viewer')",
        [randomUUID(), t, options.viewerEmail.toLowerCase(), viewerHash],
      );
    }
    for (const rate of DEMO_RATES) {
      await client.query(
        'INSERT INTO approved_rates(id,tenant_id,code,label,unit,unit_price_cents,approved_by) VALUES($1,$2,$3,$4,$5,$6,$7)',
        [randomUUID(), t, rate.code, rate.label, rate.unit, rate.unitPriceCents, ownerId],
      );
    }
    const margaret = await customer(client, t, {
      name: 'Margaret Johnson',
      preferredName: 'Mrs Johnson',
      email: 'margaret.johnson@example.test',
      phone: '+64 21 555 0101',
      address: '14 Kauri Street, Grey Lynn, Auckland (synthetic)',
    });
    // A second "Mrs Johnson" makes the canonical enquiry ambiguous, so the clarification step is exercised.
    const helen = await customer(client, t, {
      name: 'Helen Johnson',
      preferredName: 'Mrs Johnson',
      email: 'helen.johnson@example.test',
      phone: '+64 21 555 0102',
      address: '3/22 Rata Road, Mount Albert, Auckland (synthetic)',
    });
    const aroha = await customer(client, t, {
      name: 'Aroha Ngata',
      preferredName: null,
      email: 'aroha.ngata@example.test',
      phone: '+64 21 555 0103',
      address: '7 Pōhutukawa Lane, Ōrākei, Auckland (synthetic)',
    });
    await customer(client, t, {
      name: 'Sam Patel',
      preferredName: null,
      email: 'sam.patel@example.test',
      phone: '+64 21 555 0104',
      address: null,
    });
    await client.query(
      "INSERT INTO customer_contacts(id,tenant_id,customer_id,name,role,phone) VALUES($1,$2,$3,'Daniel Johnson','son, arranges access','+64 21 555 0111')",
      [randomUUID(), t, margaret],
    );

    const kitchen = await job(
      client,
      t,
      margaret,
      'Kitchen downlight replacement',
      'completed',
      '2026-03-12T21:00:00Z',
      [
        'Replaced six halogen downlights with LED. Switchboard is an older ceramic-fuse type; recommend an upgrade quote if circuits are added.',
        'Customer prefers morning visits. Dog on the property: text Daniel before arriving.',
      ],
    );
    await job(client, t, margaret, 'Outdoor sensor light', 'completed', '2025-11-04T20:00:00Z', [
      'Installed one sensor light by the back door.',
    ]);
    await job(client, t, helen, 'Heat pump isolator install', 'completed', '2026-05-20T22:00:00Z', [
      'Isolator fitted beside outdoor unit.',
    ]);
    await job(client, t, aroha, 'Switchboard inspection', 'scheduled', null, [
      'Customer asked for an inspection before a renovation.',
    ]);

    const message = randomUUID();
    const messageText =
      'Hi, it is Margaret Johnson. Two of the power points in the lounge are cracked and one sparks a bit. Could you come and replace them? Mornings are best.';
    await client.query(
      "INSERT INTO communications(id,tenant_id,customer_id,direction,channel,status,sender,subject,text,created_at) VALUES($1,$2,$3,'inbound','mock','received','margaret.johnson@example.test','Lounge power points',$4,now() - interval '2 hours')",
      [message, t, margaret, messageText],
    );
    await knowledge(client, t, margaret, null, 'communication', message, messageText);
    await client.query(
      "INSERT INTO audit_events(id,tenant_id,actor_type,action,entity_type,entity_id,request_id,metadata) VALUES($1,$2,'system','demo.seeded','business',$2,'seed',$3)",
      [
        randomUUID(),
        t,
        JSON.stringify({ syntheticData: true, taxBasisPoints, kitchenJobId: kitchen }),
      ],
    );
    return { created: true };
  });
}

async function customer(
  client: Transaction,
  tenantId: string,
  value: {
    name: string;
    preferredName: string | null;
    email: string;
    phone: string;
    address: string | null;
  },
): Promise<string> {
  const id = randomUUID();
  await client.query(
    'INSERT INTO customers(id,tenant_id,name,preferred_name,email,phone,address) VALUES($1,$2,$3,$4,$5,$6,$7)',
    [id, tenantId, value.name, value.preferredName, value.email, value.phone, value.address],
  );
  return id;
}

async function job(
  client: Transaction,
  tenantId: string,
  customerId: string,
  title: string,
  status: string,
  completedAt: string | null,
  notes: string[],
): Promise<string> {
  const id = randomUUID();
  await client.query(
    "INSERT INTO jobs(id,tenant_id,customer_id,title,status,origin,completed_at,created_at) VALUES($1,$2,$3,$4,$5,'seed',$6,coalesce($6::timestamptz, now()))",
    [id, tenantId, customerId, title, status, completedAt],
  );
  for (const text of notes) {
    const noteId = randomUUID();
    await client.query(
      "INSERT INTO job_notes(id,tenant_id,job_id,text,provenance,created_at) VALUES($1,$2,$3,$4,'verified',coalesce($5::timestamptz, now()))",
      [noteId, tenantId, id, text, completedAt],
    );
    await knowledge(client, tenantId, customerId, id, 'job_note', noteId, text, 'verified');
  }
  return id;
}

export async function knowledge(
  client: Transaction,
  tenantId: string,
  customerId: string | null,
  jobId: string | null,
  sourceType: 'communication' | 'job_note' | 'document',
  sourceId: string,
  content: string,
  provenance: 'user_supplied' | 'verified' | 'inferred' = 'user_supplied',
): Promise<string> {
  const id = randomUUID();
  await client.query(
    'INSERT INTO knowledge_items(id,tenant_id,customer_id,job_id,source_type,source_id,source_created_at,content,provenance) VALUES($1,$2,$3,$4,$5,$6,now(),$7,$8)',
    [id, tenantId, customerId, jobId, sourceType, sourceId, content, provenance],
  );
  return id;
}
