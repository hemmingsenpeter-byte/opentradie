import { suppressStaleFollowUp } from './collections.js';
import { createHash, randomUUID } from 'node:crypto';
import {
  AgentRuntimeError,
  runMessageTriage,
  type AgentRuntime,
  type MessageTriage,
} from '@opentradie/agent';
import {
  customerNameFromSender,
  decideModelUse,
  draftWarnings,
  isAutomatedEmail,
  looksLikeEnquiry,
  normaliseEmailAddress,
  normaliseSubject,
  resolveCustomer,
  subjectIsThreadable,
  type CustomerCandidate,
  type DataCategory,
} from '@opentradie/core';
import { recordAudit, transaction, type Database, type Transaction } from '@opentradie/database';
import {
  isIntegrationError,
  newMessageId,
  type InboundEmail,
  type MailConnections,
  type MailProviderName,
} from '@opentradie/integrations/mail';
import {
  PermanentTaskError,
  type FileStore,
  type PostgresJobQueue,
  type RuntimeConfig,
  type TaskHandler,
} from '@opentradie/platform';
import { agentHealthWithTimeout } from './agent-info.js';
import { proposeFromTriage, toolCallsForTriage } from './triage-proposals.js';
import {
  contentMatchesMediaType,
  extensionFor,
  safeFileName,
  type EvidenceMediaType,
} from './evidence.js';
import {
  createCustomerRecord,
  createEnquiryJob,
  indexCommunication,
  type Actor,
} from './intake.js';

export interface InboxDependencies {
  db: Database;
  queue: PostgresJobQueue;
  runtime: AgentRuntime;
  config: RuntimeConfig;
  fileStore: FileStore;
  mail: MailConnections;
}

export const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
export const ATTACHMENT_MAX_COUNT = 10;
const ATTACHMENT_TYPES: EvidenceMediaType[] = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'application/pdf',
];
const OPEN_JOB_STATUSES = ['new', 'quoted', 'scheduled', 'in_progress'];
const TRIAGE_DATA: DataCategory[] = ['communication_text', 'customer_names'];

type ReviewReason =
  | 'customer_ambiguous'
  | 'customer_name_only'
  | 'job_ambiguous'
  | 'customer_unknown'
  | 'triage_failed';

export interface MatchResult {
  customer: {
    id: string | null;
    basis: 'thread' | 'email_exact' | 'exact_name' | 'created' | 'none' | 'ambiguous' | 'surname';
    confidence: number;
    candidates: Array<{ id: string; name: string }>;
  };
  job: {
    id: string | null;
    basis: 'thread' | 'single_open_job' | 'created' | 'none' | 'ambiguous';
    confidence: number;
    candidates: Array<{ id: string; title: string }>;
  };
}

export interface IngestResult {
  status: 'accepted' | 'duplicate';
  communicationId: string;
  threadId: string;
  customerId: string | null;
  jobId: string | null;
  createdCustomer: boolean;
  createdJob: boolean;
  needsReview: boolean;
  reviewReason: ReviewReason | null;
  automated: boolean;
  attachmentsStored: number;
  attachmentsRejected: number;
}

const sha = (value: string) => createHash('sha256').update(value).digest('hex');

async function findThread(
  client: Transaction,
  tenantId: string,
  email: InboundEmail,
  fromAddress: string | null,
): Promise<string | null> {
  const headerIds = [email.inReplyTo, ...email.references].filter((v): v is string => !!v);
  if (headerIds.length) {
    const byHeader = await client.query<{ threadId: string }>(
      `SELECT thread_id AS "threadId" FROM communications
       WHERE tenant_id=$1 AND message_id_header = ANY($2::text[]) AND thread_id IS NOT NULL
       ORDER BY created_at DESC LIMIT 1`,
      [tenantId, headerIds],
    );
    if (byHeader.rows[0]) return byHeader.rows[0].threadId;
  }
  if (email.providerThreadId) {
    const byProvider = await client.query<{ id: string }>(
      "SELECT id FROM communication_threads WHERE tenant_id=$1 AND channel='email' AND external_thread_id=$2",
      [tenantId, email.providerThreadId],
    );
    if (byProvider.rows[0]) return byProvider.rows[0].id;
  }
  const subject = normaliseSubject(email.subject);
  if (fromAddress && subjectIsThreadable(subject)) {
    // Weak fallback: same sender, same normalised subject, recent, not archived.
    const bySubject = await client.query<{ id: string }>(
      `SELECT t.id FROM communication_threads t
       WHERE t.tenant_id=$1 AND t.channel='email' AND t.subject_normalised=$2 AND t.status <> 'archived'
         AND t.last_message_at > now() - interval '30 days'
         AND EXISTS (SELECT 1 FROM communications m WHERE m.tenant_id=t.tenant_id AND m.thread_id=t.id
                     AND lower(m.from_address)=$3)
       ORDER BY t.last_message_at DESC LIMIT 1`,
      [tenantId, subject, fromAddress],
    );
    if (bySubject.rows[0]) return bySubject.rows[0].id;
  }
  return null;
}

async function matchCustomer(
  client: Transaction,
  tenantId: string,
  fromAddress: string | null,
  fromName: string | null,
): Promise<MatchResult['customer']> {
  if (fromAddress) {
    const byEmail = await client.query<{ id: string; name: string }>(
      `SELECT DISTINCT c.id, c.name FROM customers c
       LEFT JOIN customer_contacts cc ON cc.tenant_id=c.tenant_id AND cc.customer_id=c.id
       WHERE c.tenant_id=$1 AND c.archived_at IS NULL AND (lower(c.email)=$2 OR lower(cc.email)=$2)
       ORDER BY c.name LIMIT 10`,
      [tenantId, fromAddress],
    );
    if (byEmail.rows.length === 1)
      return { id: byEmail.rows[0]!.id, basis: 'email_exact', confidence: 1, candidates: [] };
    if (byEmail.rows.length > 1)
      return { id: null, basis: 'ambiguous', confidence: 0, candidates: byEmail.rows };
  }
  if (fromName) {
    const candidates = await client.query<CustomerCandidate>(
      'SELECT id,name,preferred_name AS "preferredName" FROM customers WHERE tenant_id=$1 AND archived_at IS NULL',
      [tenantId],
    );
    const resolution = resolveCustomer(fromName, candidates.rows);
    if (resolution.kind === 'resolved') {
      const candidate = { id: resolution.customer.id, name: resolution.customer.name };
      // A display name is easy to fake: an exact name links with review, a partial one only suggests.
      return resolution.basis === 'exact_name'
        ? { id: candidate.id, basis: 'exact_name', confidence: 0.6, candidates: [candidate] }
        : { id: null, basis: 'surname', confidence: 0.3, candidates: [candidate] };
    }
    if (resolution.kind === 'ambiguous')
      return {
        id: null,
        basis: 'ambiguous',
        confidence: 0,
        candidates: resolution.matches.slice(0, 10).map(({ id, name }) => ({ id, name })),
      };
  }
  return { id: null, basis: 'none', confidence: 0, candidates: [] };
}

async function matchJob(
  client: Transaction,
  tenantId: string,
  customerId: string,
): Promise<MatchResult['job']> {
  const open = await client.query<{ id: string; title: string }>(
    `SELECT id,title FROM jobs WHERE tenant_id=$1 AND customer_id=$2 AND status = ANY($3::text[])
     ORDER BY created_at DESC LIMIT 10`,
    [tenantId, customerId, OPEN_JOB_STATUSES],
  );
  if (open.rows.length === 1)
    return { id: open.rows[0]!.id, basis: 'single_open_job', confidence: 0.8, candidates: [] };
  if (open.rows.length > 1)
    return { id: null, basis: 'ambiguous', confidence: 0, candidates: open.rows };
  return { id: null, basis: 'none', confidence: 0, candidates: [] };
}

function attachmentType(declared: string, content: Buffer): EvidenceMediaType | null {
  const type = declared === 'image/jpg' ? 'image/jpeg' : declared;
  return (ATTACHMENT_TYPES as string[]).includes(type) &&
    contentMatchesMediaType(content, type as EvidenceMediaType)
    ? (type as EvidenceMediaType)
    : null;
}

/**
 * Normalised email -> thread -> customer -> job -> records, in the caller's transaction. Exact
 * email address matches link automatically; anything weaker or ambiguous is marked for review
 * and never guessed. A new sender whose message reads like a request for work gets a customer
 * and a "new" job through the same intake services as POST /api/enquiries.
 */
export async function ingestEmail(
  client: Transaction,
  deps: Pick<InboxDependencies, 'queue' | 'fileStore'>,
  input: {
    tenantId: string;
    email: InboundEmail;
    provider: MailProviderName;
    origin: 'webhook' | 'manual_paste' | 'mailbox_sync';
    actor: Actor;
    requestId: string;
  },
): Promise<IngestResult> {
  const { tenantId, email } = input;
  const externalReference = `msgid:${sha(email.messageId.toLowerCase())}`;
  const duplicate = await client.query<{
    id: string;
    threadId: string;
    customerId: string | null;
    jobId: string | null;
  }>(
    `SELECT id,thread_id AS "threadId",customer_id AS "customerId",job_id AS "jobId" FROM communications
     WHERE tenant_id=$1 AND channel='email' AND external_reference=$2`,
    [tenantId, externalReference],
  );
  if (duplicate.rows[0]) {
    const row = duplicate.rows[0];
    return {
      status: 'duplicate',
      communicationId: row.id,
      threadId: row.threadId,
      customerId: row.customerId,
      jobId: row.jobId,
      createdCustomer: false,
      createdJob: false,
      needsReview: false,
      reviewReason: null,
      automated: false,
      attachmentsStored: 0,
      attachmentsRejected: 0,
    };
  }

  const fromAddress = normaliseEmailAddress(email.from?.address);
  const fromName = email.from?.name?.slice(0, 200) ?? null;
  const automated = isAutomatedEmail({ fromAddress, ...email.automation });
  const threadId = await findThread(client, tenantId, email, fromAddress);
  const thread = threadId
    ? (
        await client.query<{ customerId: string | null; jobId: string | null }>(
          'SELECT customer_id AS "customerId",job_id AS "jobId" FROM communication_threads WHERE tenant_id=$1 AND id=$2 FOR UPDATE',
          [tenantId, threadId],
        )
      ).rows[0]!
    : null;

  let reviewReason: ReviewReason | null = null;
  const customer: MatchResult['customer'] = thread?.customerId
    ? { id: thread.customerId, basis: 'thread', confidence: 1, candidates: [] }
    : await matchCustomer(client, tenantId, fromAddress, fromName);
  if (customer.basis === 'ambiguous') reviewReason = 'customer_ambiguous';
  else if (customer.basis === 'exact_name' || customer.basis === 'surname')
    reviewReason = 'customer_name_only';

  let job: MatchResult['job'] = thread?.jobId
    ? { id: thread.jobId, basis: 'thread', confidence: 1, candidates: [] }
    : customer.id
      ? await matchJob(client, tenantId, customer.id)
      : { id: null, basis: 'none', confidence: 0, candidates: [] };
  if (job.basis === 'ambiguous') reviewReason ??= 'job_ambiguous';

  const enquiry = looksLikeEnquiry({ subject: email.subject, text: email.text, automated });
  let createdCustomer = false;
  let createdJob = false;
  const communicationId = randomUUID();
  const audit = (action: string, entityType: string, entityId: string, metadata = {}) =>
    recordAudit(client, {
      tenantId,
      actorType: input.actor.type,
      actorId: input.actor.id,
      action,
      entityType,
      entityId,
      requestId: input.requestId,
      metadata,
    });

  if (!thread && customer.basis === 'none' && fromAddress && enquiry) {
    customer.id = await createCustomerRecord(client, {
      tenantId,
      name: customerNameFromSender(fromName, fromAddress),
      email: fromAddress,
    });
    customer.basis = 'created';
    customer.confidence = 1;
    createdCustomer = true;
    await audit('customer.created', 'customer', customer.id, { source: 'email' });
  }
  const mayCreateJob =
    !thread &&
    customer.id !== null &&
    (customer.basis === 'created' || customer.basis === 'email_exact') &&
    job.basis === 'none' &&
    enquiry;
  if (mayCreateJob) {
    job = {
      id: await createEnquiryJob(client, {
        tenantId,
        customerId: customer.id!,
        title: email.subject.trim() || 'Email enquiry',
        description: `Created from an email enquiry (communication ${communicationId}). Review scope before quoting.`,
        status: 'new',
        origin: 'email',
        actor: input.actor,
        eventSummary: 'Job created from an email enquiry',
        eventMetadata: { communicationId },
      }),
      basis: 'created',
      confidence: 1,
      candidates: [],
    };
    createdJob = true;
    await audit('job.created', 'job', job.id!, { customerId: customer.id, origin: 'email' });
  }
  if (!customer.id && !reviewReason && !automated) reviewReason = 'customer_unknown';

  const subjectNormalised = normaliseSubject(email.subject);
  let resolvedThreadId = threadId;
  if (!resolvedThreadId) {
    resolvedThreadId = randomUUID();
    await client.query(
      `INSERT INTO communication_threads(id,tenant_id,channel,subject,subject_normalised,customer_id,job_id,external_thread_id,needs_review,review_reason,last_message_at)
       VALUES($1,$2,'email',$3,$4,$5,$6,$7,$8,$9,now())`,
      [
        resolvedThreadId,
        tenantId,
        email.subject || null,
        subjectNormalised || null,
        customer.id,
        job.id,
        email.providerThreadId,
        reviewReason !== null,
        reviewReason,
      ],
    );
  } else {
    await client.query(
      `UPDATE communication_threads SET
         customer_id=coalesce(customer_id,$3), job_id=coalesce(job_id,$4),
         needs_review = needs_review OR $5::text IS NOT NULL,
         review_reason = coalesce(review_reason,$5),
         status = CASE WHEN status='closed' THEN 'open' ELSE status END,
         last_message_at=greatest(last_message_at, now()), updated_at=now()
       WHERE tenant_id=$1 AND id=$2`,
      [tenantId, resolvedThreadId, customer.id, job.id, reviewReason],
    );
  }

  const match: MatchResult = { customer, job };
  const rejected: Array<{ fileName: string; reason: string }> = [];
  const triage = {
    match,
    automated,
    looksLikeEnquiry: enquiry,
    textFromHtml: email.textFromHtml,
    attachments: { stored: 0, rejected },
  };
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO communications(id,tenant_id,customer_id,job_id,direction,channel,status,sender,subject,text,external_reference,
       thread_id,origin,message_id_header,in_reply_to,references_header,from_address,from_name,to_addresses,cc_addresses,
       received_at,triage,triage_status,provider,provider_message_id,provider_thread_id)
     VALUES($1,$2,$3,$4,'inbound','email','received',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,now(),$18,$19,$20,$21,$22)
     ON CONFLICT (tenant_id,channel,external_reference) WHERE external_reference IS NOT NULL DO NOTHING RETURNING id`,
    [
      communicationId,
      tenantId,
      customer.id,
      job.id,
      fromAddress,
      email.subject || null,
      email.text,
      externalReference,
      resolvedThreadId,
      input.origin,
      email.messageId,
      email.inReplyTo,
      email.references,
      fromAddress,
      fromName,
      email.to.map((item) => item.address).slice(0, 50),
      email.cc.map((item) => item.address).slice(0, 50),
      JSON.stringify(triage),
      automated ? 'not_applicable' : 'pending',
      input.provider,
      email.providerMessageId,
      email.providerThreadId,
    ],
  );
  // A concurrent delivery of the same message won the insert: roll back this attempt's work.
  if (!inserted.rows[0]) throw new DuplicateDeliveryError();

  let stored = 0;
  for (const [index, attachment] of email.attachments.entries()) {
    const content = Buffer.from(attachment.content);
    const reason =
      index >= ATTACHMENT_MAX_COUNT
        ? 'too_many_attachments'
        : content.length === 0
          ? 'empty'
          : content.length > ATTACHMENT_MAX_BYTES
            ? 'too_large'
            : null;
    const mediaType = reason ? null : attachmentType(attachment.mediaType, content);
    if (reason || !mediaType) {
      rejected.push({
        fileName: attachment.fileName.slice(0, 150),
        reason: reason ?? 'type_not_allowed',
      });
      continue;
    }
    const documentId = randomUUID();
    const key = `tenants/${tenantId}/communications/${communicationId}/${documentId}.${extensionFor(mediaType)}`;
    const file = await deps.fileStore.put(key, content, { contentType: mediaType });
    const digest = createHash('sha256').update(content).digest('hex');
    if (file.sha256 !== digest) throw new Error('Stored attachment checksum mismatch.');
    await client.query(
      'INSERT INTO documents(id,tenant_id,customer_id,job_id,communication_id,kind,storage_key,file_name,media_type,size_bytes,sha256) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
      [
        documentId,
        tenantId,
        customer.id,
        job.id,
        communicationId,
        mediaType.startsWith('image/') ? 'photo' : 'attachment',
        key,
        safeFileName(attachment.fileName, mediaType),
        mediaType,
        content.length,
        digest,
      ],
    );
    stored++;
  }
  triage.attachments.stored = stored;
  if (stored || rejected.length)
    await client.query('UPDATE communications SET triage=$3 WHERE tenant_id=$1 AND id=$2', [
      tenantId,
      communicationId,
      JSON.stringify(triage),
    ]);

  await indexCommunication(client, deps.queue, {
    tenantId,
    communicationId,
    customerId: customer.id,
    jobId: job.id,
    content: `${email.subject}\n\n${email.text}`.trim(),
  });
  await audit('communication.received', 'communication', communicationId, {
    channel: 'email',
    provider: input.provider,
    origin: input.origin,
    threadId: resolvedThreadId,
    customerMatch: customer.basis,
    jobMatch: job.basis,
    needsReview: reviewReason,
    automated,
    attachmentsStored: stored,
    attachmentsRejected: rejected.length,
  });
  if (!automated)
    await deps.queue.enqueue(
      {
        tenantId,
        kind: 'inbox.triage',
        payload: { communicationId },
        idempotencyKey: `triage:${communicationId}`,
      },
      client,
    );
  return {
    status: 'accepted',
    communicationId,
    threadId: resolvedThreadId,
    customerId: customer.id,
    jobId: job.id,
    createdCustomer,
    createdJob,
    needsReview: reviewReason !== null,
    reviewReason,
    automated,
    attachmentsStored: stored,
    attachmentsRejected: rejected.length,
  };
}

export class DuplicateDeliveryError extends Error {
  constructor() {
    super('The same message was delivered concurrently.');
    this.name = 'DuplicateDeliveryError';
  }
}

interface TriageSource {
  id: string;
  threadId: string | null;
  customerId: string | null;
  jobId: string | null;
  subject: string | null;
  text: string;
  fromAddress: string | null;
  fromName: string | null;
  messageIdHeader: string | null;
  referencesHeader: string[];
  provider: MailProviderName | null;
  providerThreadId: string | null;
  triage: Record<string, unknown> | null;
  triageStatus: string;
}

async function setTriageOutcome(
  db: Database,
  tenantId: string,
  communicationId: string,
  status: 'policy_denied' | 'unavailable' | 'invalid_output',
  detail: Record<string, unknown>,
  requestId: string,
) {
  await transaction(db, async (client) => {
    const updated = await client.query(
      `UPDATE communications SET triage_status=$3, triage=coalesce(triage,'{}'::jsonb) || $4::jsonb, updated_at=now()
       WHERE tenant_id=$1 AND id=$2 AND triage_status='pending'`,
      [tenantId, communicationId, status, JSON.stringify({ outcome: detail })],
    );
    if (!updated.rowCount) return;
    await recordAudit(client, {
      tenantId,
      actorType: 'system',
      actorId: null,
      action: status === 'policy_denied' ? 'model.policy_denied' : `communication.triage_${status}`,
      entityType: 'communication',
      entityId: communicationId,
      requestId,
      metadata: { purpose: 'message_triage', ...detail },
    });
  });
}

/**
 * Summarise, classify and draft a reply for one inbound message. Idempotent: only a message in
 * triage_status "pending" is processed, and the database allows one agent draft per message.
 * The privacy decision comes first; a denied or unsupported runtime records the outcome and
 * creates no draft (no fallback). Nothing here sends anything.
 */
export async function triageCommunication(
  deps: Pick<InboxDependencies, 'db' | 'runtime' | 'config'>,
  tenantId: string,
  communicationId: string,
  requestId: string,
): Promise<'completed' | 'skipped' | 'policy_denied' | 'unavailable' | 'invalid_output'> {
  const { db, runtime, config } = deps;
  const source = (
    await db.pool.query<TriageSource>(
      `SELECT id,thread_id AS "threadId",customer_id AS "customerId",job_id AS "jobId",subject,text,
         from_address AS "fromAddress",from_name AS "fromName",message_id_header AS "messageIdHeader",
         references_header AS "referencesHeader",provider,provider_thread_id AS "providerThreadId",
         triage,triage_status AS "triageStatus"
       FROM communications WHERE tenant_id=$1 AND id=$2 AND direction='inbound'`,
      [tenantId, communicationId],
    )
  ).rows[0];
  if (!source) throw new PermanentTaskError('Communication not found for this tenant.');
  if (source.triageStatus !== 'pending') return 'skipped';

  const health = await agentHealthWithTimeout(runtime, 10_000);
  if (!health || health.status !== 'ok') throw new Error('Agent runtime unavailable.');
  const decision = decideModelUse({
    mode: config.privacyMode,
    purpose: 'message_triage',
    destination: {
      provider: health.provider,
      location: health.inferenceLocation,
      attestation: health.attestation,
    },
    dataCategories: TRIAGE_DATA,
  });
  if (!decision.allowed) {
    await setTriageOutcome(
      db,
      tenantId,
      communicationId,
      'policy_denied',
      {
        reason: decision.reason,
        provider: decision.destination.provider,
        location: decision.destination.location,
        mode: decision.mode,
        explanation: decision.explanation,
      },
      requestId,
    );
    return 'policy_denied';
  }

  const context = await db.pool.query<{
    businessName: string;
    customerName: string | null;
    jobTitle: string | null;
  }>(
    `SELECT b.name AS "businessName",c.name AS "customerName",j.title AS "jobTitle"
     FROM businesses b
     LEFT JOIN customers c ON c.tenant_id=b.id AND c.id=$2
     LEFT JOIN jobs j ON j.tenant_id=b.id AND j.id=$3
     WHERE b.id=$1`,
    [tenantId, source.customerId, source.jobId],
  );
  const documents = await db.pool.query<{ fileName: string }>(
    'SELECT file_name AS "fileName" FROM documents WHERE tenant_id=$1 AND communication_id=$2 ORDER BY created_at',
    [tenantId, communicationId],
  );
  const rejectedNames = (
    ((source.triage?.attachments as { rejected?: Array<{ fileName: string }> } | undefined)
      ?.rejected ?? []) as Array<{ fileName: string }>
  ).map((item) => item.fileName);
  let result: Awaited<ReturnType<typeof runMessageTriage>>;
  try {
    result = await runMessageTriage(runtime, {
      requestId: `triage-${communicationId}`,
      message: {
        subject: (source.subject ?? '').slice(0, 300),
        senderName: source.fromName ?? '',
        bodyText: source.text.slice(0, 20_000),
        attachmentNames: [...documents.rows.map((row) => row.fileName), ...rejectedNames]
          .slice(0, 20)
          .map((name) => name.slice(0, 150)),
      },
      context: {
        businessName: context.rows[0]?.businessName ?? 'the business',
        customerName: context.rows[0]?.customerName ?? null,
        // A job created from this very message is not "an existing job" for classification.
        jobTitle:
          (source.triage?.match as MatchResult | undefined)?.job.basis === 'created'
            ? null
            : (context.rows[0]?.jobTitle ?? null),
      },
    });
  } catch (error) {
    if (error instanceof AgentRuntimeError && error.code === 'INVALID_OUTPUT') {
      await setTriageOutcome(db, tenantId, communicationId, 'invalid_output', {}, requestId);
      return 'invalid_output';
    }
    // Gateway outages and timeouts are recorded once (no retry storm, no fallback runtime).
    if (
      error instanceof AgentRuntimeError &&
      (error.code === 'UNAVAILABLE' || error.code === 'TIMEOUT' || error.code === 'CANCELLED')
    ) {
      await setTriageOutcome(
        db,
        tenantId,
        communicationId,
        'unavailable',
        { runtime: health.runtime, code: error.code },
        requestId,
      );
      return 'unavailable';
    }
    throw error;
  }
  await storeTriage(db, tenantId, source, result, health.runtime, requestId);
  return 'completed';
}

async function storeTriage(
  db: Database,
  tenantId: string,
  source: TriageSource,
  result: { triage: MessageTriage; synthetic: boolean; runtime: string },
  runtimeName: string,
  requestId: string,
) {
  const { triage } = result;
  const warnings = draftWarnings(triage.replyDraft);
  await transaction(db, async (client) => {
    const locked = await client.query<{ triageStatus: string }>(
      'SELECT triage_status AS "triageStatus" FROM communications WHERE tenant_id=$1 AND id=$2 FOR UPDATE',
      [tenantId, source.id],
    );
    if (locked.rows[0]?.triageStatus !== 'pending') return;
    await client.query(
      `UPDATE communications SET triage_status='completed', updated_at=now(),
         triage=coalesce(triage,'{}'::jsonb) || $3::jsonb
       WHERE tenant_id=$1 AND id=$2`,
      [
        tenantId,
        source.id,
        JSON.stringify({
          classification: triage.classification,
          summary: triage.summary,
          suggestedActions: triage.suggestedActions,
          draftWarnings: warnings,
          runtime: runtimeName,
          synthetic: result.synthetic,
        }),
      ],
    );
    const audit = (
      actorType: 'system' | 'agent',
      action: string,
      entityId: string,
      metadata: Record<string, unknown>,
    ) =>
      recordAudit(client, {
        tenantId,
        actorType,
        actorId: null,
        action,
        entityType: 'communication',
        entityId,
        requestId,
        metadata,
      });
    // Suggestions become pending proposals in the Approval inbox; nothing executes here.
    const proposals = await proposeFromTriage(client, {
      tenantId,
      requestId,
      communicationId: source.id,
      calls: await toolCallsForTriage(client, tenantId, triage, {
        communicationId: source.id,
        customerId: source.customerId,
        jobId: source.jobId,
        jobCreatedFromMessage:
          (source.triage?.match as MatchResult | undefined)?.job.basis === 'created',
        subject: source.subject,
        senderLabel: source.fromName || source.fromAddress || 'the sender',
      }),
    });
    await audit('system', 'communication.triaged', source.id, {
      classification: triage.classification,
      suggestedActions: triage.suggestedActions.map((action) => action.type),
      proposalIds: proposals.created,
      runtime: runtimeName,
      synthetic: result.synthetic,
    });
    if (!triage.replyDraft || !source.fromAddress || triage.classification === 'spam_or_automated')
      return;
    const draftId = randomUUID();
    const subject = source.subject ?? '';
    const created = await client.query(
      `INSERT INTO communications(id,tenant_id,customer_id,job_id,direction,channel,status,subject,text,thread_id,origin,
         in_reply_to,references_header,to_addresses,reply_to_communication_id,provider,provider_thread_id,triage)
       VALUES($1,$2,$3,$4,'outbound','email','draft',$5,$6,$7,'agent_draft',$8,$9,$10,$11,$12,$13,$14)
       ON CONFLICT (tenant_id,reply_to_communication_id) WHERE origin='agent_draft' DO NOTHING RETURNING id`,
      [
        draftId,
        tenantId,
        source.customerId,
        source.jobId,
        /^re:/i.test(subject) ? subject : `Re: ${subject || 'your message'}`.slice(0, 300),
        triage.replyDraft,
        source.threadId,
        source.messageIdHeader,
        [
          ...source.referencesHeader,
          ...(source.messageIdHeader ? [source.messageIdHeader] : []),
        ].slice(-50),
        [source.fromAddress],
        source.id,
        source.provider,
        source.providerThreadId,
        JSON.stringify({ draftWarnings: warnings, synthetic: result.synthetic }),
      ],
    );
    if (created.rowCount)
      await audit('agent', 'communication.draft_created', draftId, {
        replyTo: source.id,
        threadId: source.threadId,
        warnings,
        synthetic: result.synthetic,
      });
  });
}

// ---------- approval and sending ----------

export interface SendableRow {
  id: string;
  status: string;
  channel: string;
  direction: string;
  text: string;
  subject: string | null;
  toAddresses: string[];
  customerEmail: string | null;
  sendAttempt: number;
  threadId: string | null;
}

/** Map adapter errors to short, safe codes shown to the owner. */
export function sendErrorCode(error: unknown): string {
  if (!isIntegrationError(error)) return 'SEND_FAILED';
  switch (error.kind) {
    case 'auth_expired':
      return 'PROVIDER_AUTH_EXPIRED';
    case 'reauthorisation_required':
      return 'MAIL_REAUTHORISATION_REQUIRED';
    case 'rate_limited':
      return 'PROVIDER_RATE_LIMITED';
    case 'validation':
    case 'conflict':
      return 'PROVIDER_REJECTED';
    case 'transient':
      return 'PROVIDER_UNAVAILABLE';
    default:
      return 'SEND_FAILED';
  }
}

/**
 * Background send of one owner-approved message. At most once: the row moves approved ->
 * sending before the provider call and sending -> sent after it. A retry that finds "sending"
 * (a crash mid-send) never sends again; it records SEND_OUTCOME_UNKNOWN for the owner to check.
 * With no mail connection the message fails visibly with NO_MAIL_CONNECTION; a connection whose
 * grant was revoked or expired fails it with MAIL_REAUTHORISATION_REQUIRED (also when the token
 * refresh during the send is refused). Nothing is resent automatically.
 */
export async function sendApprovedCommunication(
  deps: Pick<InboxDependencies, 'db' | 'mail'>,
  tenantId: string,
  communicationId: string,
  requestId: string,
): Promise<'sent' | 'skipped'> {
  const { db } = deps;
  const fail = async (client: Transaction, code: string) => {
    await client.query(
      "UPDATE communications SET status='failed', send_error_code=$3, updated_at=now() WHERE tenant_id=$1 AND id=$2",
      [tenantId, communicationId, code],
    );
    await recordAudit(client, {
      tenantId,
      actorType: 'system',
      actorId: null,
      action: 'communication.send_failed',
      entityType: 'communication',
      entityId: communicationId,
      requestId,
      metadata: { code },
    });
  };
  const prepared = await transaction(db, async (client) => {
    const row = (
      await client.query<{
        status: string;
        providerMessageId: string | null;
        subject: string | null;
        text: string;
        toAddresses: string[];
        inReplyTo: string | null;
        referencesHeader: string[];
        providerThreadId: string | null;
        replyToProviderMessageId: string | null;
        threadId: string | null;
      }>(
        `SELECT m.status,m.provider_message_id AS "providerMessageId",m.subject,m.text,m.to_addresses AS "toAddresses",
           m.in_reply_to AS "inReplyTo",m.references_header AS "referencesHeader",m.provider_thread_id AS "providerThreadId",
           r.provider_message_id AS "replyToProviderMessageId",m.thread_id AS "threadId"
         FROM communications m
         LEFT JOIN communications r ON r.tenant_id=m.tenant_id AND r.id=m.reply_to_communication_id
         WHERE m.tenant_id=$1 AND m.id=$2 AND m.direction='outbound' FOR UPDATE OF m`,
        [tenantId, communicationId],
      )
    ).rows[0];
    if (!row) throw new PermanentTaskError('Communication not found for this tenant.');
    if (row.status === 'sent' || row.providerMessageId) return null;
    if (row.status === 'sending') {
      await fail(client, 'SEND_OUTCOME_UNKNOWN');
      return { error: 'SEND_OUTCOME_UNKNOWN' };
    }
    if (row.status !== 'approved') return null;
    // A payment follow-up whose invoice was paid, voided or held since drafting is withdrawn.
    if (await suppressStaleFollowUp(client, tenantId, communicationId, requestId)) return null;
    let provider: Awaited<ReturnType<typeof deps.mail.forTenant>>;
    try {
      provider = await deps.mail.forTenant(tenantId);
    } catch (error) {
      // A connection in error (revoked or expired grant): fail visibly, never send.
      const code = sendErrorCode(error);
      await fail(client, code);
      return { error: code };
    }
    if (!provider) {
      await fail(client, 'NO_MAIL_CONNECTION');
      return { error: 'NO_MAIL_CONNECTION' };
    }
    await client.query(
      "UPDATE communications SET status='sending', updated_at=now() WHERE tenant_id=$1 AND id=$2",
      [tenantId, communicationId],
    );
    return { error: null, row, provider };
  });
  if (!prepared) return 'skipped';
  if (prepared.error !== null) throw new PermanentTaskError(prepared.error);

  const { row, provider } = prepared as Required<typeof prepared> & { error: null };
  const messageId = newMessageId();
  let result: Awaited<ReturnType<typeof provider.send>>;
  try {
    result = await provider.send({
      to: row.toAddresses.map((address) => ({ address, name: null })),
      subject: row.subject ?? '',
      text: row.text,
      inReplyTo: row.inReplyTo,
      references: row.referencesHeader,
      providerThreadId: row.providerThreadId,
      replyToProviderMessageId: row.replyToProviderMessageId,
      messageId,
    });
  } catch (error) {
    const code = sendErrorCode(error);
    await transaction(db, (client) => fail(client, code));
    // Never resent automatically: the owner re-approves to try again.
    throw new PermanentTaskError(code);
  }
  // The provider accepted the message. From here on it must never be marked as a plain
  // failure: an owner retry would then send a duplicate.
  try {
    await transaction(db, async (client) => {
      await client.query(
        `UPDATE communications SET status='sent', sent_at=now(), provider=$3, provider_message_id=$4,
           provider_thread_id=coalesce($5,provider_thread_id), message_id_header=$6, send_error_code=NULL, updated_at=now()
         WHERE tenant_id=$1 AND id=$2`,
        [
          tenantId,
          communicationId,
          provider.provider,
          result.providerMessageId,
          result.providerThreadId,
          messageId,
        ],
      );
      if (row.threadId)
        await client.query(
          'UPDATE communication_threads SET last_message_at=now(), updated_at=now() WHERE tenant_id=$1 AND id=$2',
          [tenantId, row.threadId],
        );
      await recordAudit(client, {
        tenantId,
        actorType: 'system',
        actorId: null,
        action: 'communication.sent',
        entityType: 'communication',
        entityId: communicationId,
        requestId,
        metadata: { provider: provider.provider },
      });
    });
    return 'sent';
  } catch {
    return recordAcceptedSendFallback(db, tenantId, communicationId, requestId, {
      provider: provider.provider,
      providerMessageId: result.providerMessageId,
      messageId,
    });
  }
}

/**
 * Recording an accepted send failed (for example a duplicate provider message id). Record it as
 * sent without the provider id, or, if even that fails, as SEND_OUTCOME_UNKNOWN. Never as a plain
 * failure and never resent automatically. Only codes are recorded, never message content.
 */
async function recordAcceptedSendFallback(
  db: InboxDependencies['db'],
  tenantId: string,
  communicationId: string,
  requestId: string,
  sent: { provider: string; providerMessageId: string; messageId: string },
): Promise<'sent'> {
  try {
    await transaction(db, async (client) => {
      // The provider id could not be stored (e.g. it clashes); the row is still recorded as sent.
      const updated = await client.query(
        `UPDATE communications SET status='sent', sent_at=now(), provider=$3, message_id_header=$4,
           send_error_code='SENT_RECORDING_INCOMPLETE', updated_at=now()
         WHERE tenant_id=$1 AND id=$2`,
        [tenantId, communicationId, sent.provider, sent.messageId],
      );
      if (updated.rowCount !== 1) throw new Error('not updated');
      await recordAudit(client, {
        tenantId,
        actorType: 'system',
        actorId: null,
        action: 'communication.sent',
        entityType: 'communication',
        entityId: communicationId,
        requestId,
        metadata: { provider: sent.provider, code: 'SENT_RECORDING_INCOMPLETE' },
      });
    });
    return 'sent';
  } catch {
    try {
      await db.pool.query(
        "UPDATE communications SET status='failed', send_error_code='SEND_OUTCOME_UNKNOWN', updated_at=now() WHERE tenant_id=$1 AND id=$2",
        [tenantId, communicationId],
      );
    } catch {
      // The row stays 'sending'; a retry records SEND_OUTCOME_UNKNOWN and never resends.
    }
    throw new PermanentTaskError('SEND_OUTCOME_UNKNOWN');
  }
}

/** Inbox tasks need the agent runtime and mail connections, so the API process runs them. */
export const INBOX_TASK_KINDS = ['inbox.triage', 'inbox.send'] as const;

export function createInboxTaskHandlers(
  deps: Pick<InboxDependencies, 'db' | 'runtime' | 'config' | 'mail'>,
): Record<string, TaskHandler> {
  const idOf = (payload: Record<string, unknown>) => {
    const id = typeof payload.communicationId === 'string' ? payload.communicationId : '';
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new PermanentTaskError('Invalid communication id.');
    return id;
  };
  return {
    'inbox.triage': async (task) => {
      await triageCommunication(deps, task.tenantId, idOf(task.payload), `task:${task.id}`);
    },
    'inbox.send': async (task) => {
      await sendApprovedCommunication(deps, task.tenantId, idOf(task.payload), `task:${task.id}`);
    },
  };
}
