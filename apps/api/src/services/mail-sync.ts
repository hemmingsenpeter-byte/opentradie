/**
 * Scheduled mailbox sync (ADR 0026 amendment). A `mail.sync` task polls the connected Gmail or
 * Microsoft Graph mailbox with MailProvider.listChanges, using the change cursor stored on the
 * connection row, and feeds each new inbound message through the same ingestEmail pipeline as the
 * signed webhook and the paste route. Duplicates (by provider id or Message-ID) are never stored
 * twice. The cursor advances only after every message of the batch has been committed. If the
 * provider has expired the cursor (Gmail 404, Graph 410) it restarts from now, the gap is not
 * back-filled, and the connection records a `cursor_reset` warning shown in Settings › Mail.
 */
import { recordAudit, transaction, type Database, type Queryable } from '@opentradie/database';
import {
  AuthExpiredError,
  isIntegrationError,
  ReauthorisationRequiredError,
} from '@opentradie/integrations';
import type { MailProviderName } from '@opentradie/integrations/mail';
import type { FileStore, MailRuntime, PostgresJobQueue, TaskHandler } from '@opentradie/platform';
import { DuplicateDeliveryError, ingestEmail } from './inbox.js';

export const MAIL_SYNC_KIND = 'mail.sync';
export const MAIL_SYNC_INTERVAL_MS = 5 * 60_000;
/** Messages fetched per run; the rest wait for an immediate follow-up run. */
export const MAIL_SYNC_MAX_MESSAGES = 25;

export interface MailSyncDependencies {
  db: Database;
  queue: PostgresJobQueue;
  fileStore: FileStore;
  mail: MailRuntime | null;
}

export interface MailSyncSummary {
  outcome:
    'synced' | 'cursor_initialised' | 'cursor_reset' | 'not_connected' | 'reauthorisation_required';
  errorCode: 'MAIL_REAUTHORISATION_REQUIRED' | null;
  imported: number;
  duplicates: number;
  skippedOwn: number;
  rejected: number;
  /** True when more changes remain than one run takes; a follow-up run is queued. */
  more: boolean;
}

const bucket = (at: Date) =>
  new Date(Math.floor(at.getTime() / MAIL_SYNC_INTERVAL_MS) * MAIL_SYNC_INTERVAL_MS).toISOString();

/** One sync task per 5-minute bucket per tenant (or a keyed follow-up/manual run). */
export function scheduleMailSync(
  queue: PostgresJobQueue,
  client: Queryable,
  tenantId: string,
  runAt: Date,
  key = `mail-sync:${bucket(runAt)}`,
) {
  return queue.enqueue(
    { tenantId, kind: MAIL_SYNC_KIND, payload: {}, idempotencyKey: key, runAt, maxAttempts: 3 },
    client,
  );
}

const empty = (outcome: MailSyncSummary['outcome']): MailSyncSummary => ({
  outcome,
  errorCode: outcome === 'reauthorisation_required' ? 'MAIL_REAUTHORISATION_REQUIRED' : null,
  imported: 0,
  duplicates: 0,
  skippedOwn: 0,
  rejected: 0,
  more: false,
});

/**
 * Polls the mailbox once. Ingestion errors propagate (the task retries) and leave the cursor
 * where it was; a revoked grant marks the connection `error` and returns without throwing.
 */
export async function syncMailbox(
  deps: MailSyncDependencies,
  tenantId: string,
  requestId: string,
): Promise<MailSyncSummary> {
  const runtime = deps.mail;
  if (!runtime) return empty('not_connected');
  const pool = deps.db.pool;
  const row = (
    await pool.query<{ status: string; cursor: string | null }>(
      'SELECT status,sync_cursor AS cursor FROM provider_connections WHERE tenant_id=$1 AND provider=$2',
      [tenantId, runtime.provider],
    )
  ).rows[0];
  if (!row || row.status === 'disconnected') return empty('not_connected');
  if (row.status === 'error') return empty('reauthorisation_required');
  const providerName = runtime.routeProvider as MailProviderName;

  const markReauth = async () => {
    await transaction(deps.db, async (client) => {
      await client.query(
        `UPDATE provider_connections SET status='error',status_reason='reauthorisation_required',updated_at=now()
         WHERE tenant_id=$1 AND provider=$2 AND status='connected'`,
        [tenantId, runtime.provider],
      );
      await recordAudit(client, {
        tenantId,
        actorType: 'system',
        actorId: null,
        action: 'mail.sync_failed',
        entityType: 'provider_connection',
        requestId,
        metadata: { provider: runtime.provider, errorCode: 'MAIL_REAUTHORISATION_REQUIRED' },
      });
    });
    return empty('reauthorisation_required');
  };
  const isReauth = (error: unknown) =>
    error instanceof ReauthorisationRequiredError || error instanceof AuthExpiredError;

  const saveCursor = (cursor: string) =>
    pool.query(
      `UPDATE provider_connections SET sync_cursor=$3,last_synced_at=now(),updated_at=now()
       WHERE tenant_id=$1 AND provider=$2`,
      [tenantId, runtime.provider, cursor],
    );

  try {
    const provider = await runtime.mail.forTenant(tenantId);
    if (!provider) return empty('not_connected');
    const changes = await provider.listChanges(row.cursor);
    if (row.cursor === null) {
      // First run: start from now; existing mail is not imported.
      await saveCursor(changes.nextCursor);
      return empty('cursor_initialised');
    }
    if (changes.cursorReset) {
      await transaction(deps.db, async (client) => {
        await client.query(
          `UPDATE provider_connections SET sync_cursor=$3,last_synced_at=now(),sync_warning='cursor_reset',
             sync_warning_at=now(),updated_at=now()
           WHERE tenant_id=$1 AND provider=$2`,
          [tenantId, runtime.provider, changes.nextCursor],
        );
        await recordAudit(client, {
          tenantId,
          actorType: 'system',
          actorId: null,
          action: 'mail.sync_cursor_reset',
          entityType: 'provider_connection',
          requestId,
          metadata: { provider: runtime.provider, imported: 0 },
        });
      });
      return empty('cursor_reset');
    }
    const summary = empty('synced');
    // Ids already stored (inbound via webhook, or our own sent mail) are not fetched again.
    const known = new Set(
      (
        await pool.query<{ id: string }>(
          `SELECT provider_message_id AS id FROM communications
           WHERE tenant_id=$1 AND channel='email' AND provider=$2 AND provider_message_id = ANY($3::text[])`,
          [tenantId, providerName, changes.messageIds],
        )
      ).rows.map((r) => r.id),
    );
    const fresh = changes.messageIds.filter((id) => !known.has(id));
    summary.duplicates += changes.messageIds.length - fresh.length;
    const batch = fresh.slice(0, MAIL_SYNC_MAX_MESSAGES);
    summary.more = fresh.length > batch.length;
    for (const id of batch) {
      let email;
      try {
        email = await provider.fetchMessage(id);
      } catch (error) {
        // A message the provider cannot give us readably must not block the mailbox forever.
        if (isIntegrationError(error) && error.kind === 'permanent') {
          summary.rejected += 1;
          continue;
        }
        throw error;
      }
      const own = await pool.query(
        `SELECT 1 FROM communications WHERE tenant_id=$1 AND direction='outbound' AND message_id_header=$2 LIMIT 1`,
        [tenantId, email.messageId],
      );
      if (own.rowCount) {
        summary.skippedOwn += 1;
        continue;
      }
      try {
        const result = await transaction(deps.db, (client) =>
          ingestEmail(client, deps, {
            tenantId,
            email,
            provider: providerName,
            origin: 'mailbox_sync',
            actor: { type: 'system', id: null },
            requestId,
          }),
        );
        if (result.status === 'duplicate') summary.duplicates += 1;
        else summary.imported += 1;
      } catch (error) {
        if (!(error instanceof DuplicateDeliveryError)) throw error;
        summary.duplicates += 1;
      }
    }
    // Every message of the batch is committed: only now may the cursor move. With more pending
    // the cursor stays, and the follow-up run skips the already stored ids cheaply.
    if (summary.more)
      await pool.query(
        'UPDATE provider_connections SET last_synced_at=now() WHERE tenant_id=$1 AND provider=$2',
        [tenantId, runtime.provider],
      );
    else await saveCursor(changes.nextCursor);
    return summary;
  } catch (error) {
    if (isReauth(error)) return markReauth();
    throw error;
  }
}

/** The `mail.sync` handler: sync, then chain the next run while the mailbox is connected. */
export function createMailSyncTaskHandlers(
  deps: MailSyncDependencies,
): Record<string, TaskHandler> {
  return {
    [MAIL_SYNC_KIND]: async (task) => {
      let summary: MailSyncSummary;
      try {
        summary = await syncMailbox(deps, task.tenantId, `task:${task.id}`);
      } catch (error) {
        // Self-healing: a failing run must not end the polling cycle. The next 5-minute bucket
        // is queued under its bucket key (deduplicated across retries) before the retry/failure.
        await scheduleMailSync(
          deps.queue,
          deps.db.pool,
          task.tenantId,
          new Date(Date.now() + MAIL_SYNC_INTERVAL_MS),
        ).catch(() => undefined);
        throw error;
      }
      if (summary.outcome === 'not_connected' || summary.outcome === 'reauthorisation_required')
        return;
      const at = summary.more ? new Date() : new Date(Date.now() + MAIL_SYNC_INTERVAL_MS);
      await scheduleMailSync(
        deps.queue,
        deps.db.pool,
        task.tenantId,
        at,
        summary.more ? `mail-sync:more:${task.id}` : undefined,
      );
    },
  };
}
