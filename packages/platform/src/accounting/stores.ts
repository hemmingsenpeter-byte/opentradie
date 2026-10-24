import { transaction, type Database, type Queryable } from '@opentradie/database';
import type {
  ConnectionProvider,
  ConnectionStore,
  ExternalEntityType,
  ExternalReferenceStore,
  ProviderConnectionRecord,
} from '@opentradie/integrations';
import { ConflictError } from '@opentradie/integrations';

/**
 * PostgreSQL ConnectionStore over provider_connections. Every query is tenant-scoped.
 * `withLock` holds SELECT ... FOR UPDATE on the connection row for the duration of `work`, so two
 * workers (or the API and a worker) cannot both spend the same single-use refresh token.
 */
export class PostgresConnectionStore implements ConnectionStore {
  constructor(
    private readonly db: Database,
    private readonly client: Queryable = db.pool,
  ) {}

  async get(
    tenantId: string,
    provider: ConnectionProvider,
  ): Promise<ProviderConnectionRecord | null> {
    const result = await this.client.query<ProviderConnectionRecord>(
      `SELECT id,tenant_id AS "tenantId",provider,status,encrypted_credentials AS "encryptedCredentials",
         encryption_key_id AS "encryptionKeyId",external_account_id AS "externalAccountId",updated_at AS "updatedAt"
       FROM provider_connections WHERE tenant_id=$1 AND provider=$2`,
      [tenantId, provider],
    );
    return result.rows[0] ?? null;
  }

  async upsert(record: ProviderConnectionRecord): Promise<void> {
    if ((record.encryptedCredentials === null) !== (record.encryptionKeyId === null))
      throw new Error('encrypted_credentials and encryption_key_id must be set together.');
    await this.client.query(
      `INSERT INTO provider_connections(id,tenant_id,provider,status,encrypted_credentials,encryption_key_id,external_account_id,updated_at,
         status_reason,connected_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,
         CASE WHEN $4='error' THEN 'reauthorisation_required' END, CASE WHEN $4='connected' THEN now() END)
       ON CONFLICT (tenant_id,provider) DO UPDATE SET
         status=EXCLUDED.status,
         encrypted_credentials=EXCLUDED.encrypted_credentials,
         encryption_key_id=EXCLUDED.encryption_key_id,
         external_account_id=EXCLUDED.external_account_id,
         updated_at=EXCLUDED.updated_at,
         status_reason=CASE
           WHEN EXCLUDED.status='connected' THEN NULL
           WHEN EXCLUDED.status='error' THEN 'reauthorisation_required'
           ELSE provider_connections.status_reason END,
         connected_at=CASE
           WHEN EXCLUDED.status='connected' AND provider_connections.status<>'connected' THEN now()
           ELSE provider_connections.connected_at END`,
      [
        record.id,
        record.tenantId,
        record.provider,
        record.status,
        record.encryptedCredentials,
        record.encryptionKeyId,
        record.externalAccountId,
        record.updatedAt,
      ],
    );
  }

  async withLock<T>(
    tenantId: string,
    provider: ConnectionProvider,
    work: (locked: ConnectionStore) => Promise<T>,
  ): Promise<T> {
    return transaction(this.db, async (client) => {
      await client.query(
        'SELECT 1 FROM provider_connections WHERE tenant_id=$1 AND provider=$2 FOR UPDATE',
        [tenantId, provider],
      );
      return work(new PostgresConnectionStore(this.db, client));
    });
  }
}

/** Our entity id ↔ provider id, unique in both directions per tenant, provider and entity type. */
export class PostgresExternalReferenceStore implements ExternalReferenceStore {
  constructor(private readonly client: Queryable) {}

  async get(
    tenantId: string,
    provider: ConnectionProvider,
    entityType: ExternalEntityType,
    internalId: string,
  ): Promise<string | null> {
    const result = await this.client.query<{ externalId: string }>(
      `SELECT external_id AS "externalId" FROM external_references
       WHERE tenant_id=$1 AND provider=$2 AND entity_type=$3 AND entity_id=$4`,
      [tenantId, provider, entityType, internalId],
    );
    return result.rows[0]?.externalId ?? null;
  }

  /**
   * Contacts may be re-mapped (the provider contact was replaced). An invoice mapping is never
   * overwritten: a different external id for the same invoice is a conflict for the owner.
   */
  async put(
    tenantId: string,
    provider: ConnectionProvider,
    entityType: ExternalEntityType,
    internalId: string,
    externalId: string,
  ): Promise<void> {
    const result = await this.client
      .query<{ externalId: string }>(
        `INSERT INTO external_references(tenant_id,provider,entity_type,entity_id,external_id) VALUES($1,$2,$3,$4,$5)
         ON CONFLICT (tenant_id,provider,entity_type,entity_id) DO UPDATE SET external_id=EXCLUDED.external_id, updated_at=now()
           WHERE external_references.entity_type='contact' OR external_references.external_id=EXCLUDED.external_id
         RETURNING external_id AS "externalId"`,
        [tenantId, provider, entityType, internalId, externalId],
      )
      .catch((error: unknown) => {
        // The reverse direction (one external record, two of ours) is unique too.
        if ((error as { code?: string }).code === '23505') return { rows: [] };
        throw error;
      });
    if (!result.rows[0])
      throw new ConflictError(
        'This record is already linked to a different accounting record.',
        'reference_conflict',
        provider,
      );
  }
}
