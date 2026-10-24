import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { MockAgentRuntime, type AgentRuntime } from '@opentradie/agent';
import type { EmbeddingProvider } from '@opentradie/core';
import { seed, type Database } from '@opentradie/database';
import type { MailConnections } from '@opentradie/integrations/mail';
import {
  createAccountingRuntime,
  createMailRuntime,
  type MailRuntime,
  type MailRuntimeOverrides,
  LocalFileStore,
  loadRuntimeConfig,
  type AccountingRuntime,
  type AccountingRuntimeOverrides,
  type FileStore,
  type RuntimeConfig,
} from '@opentradie/platform';
import { buildApp, type App } from '../../apps/api/src/app.js';
import { createTestDatabase } from './db.js';

export const TENANT_A = '11111111-1111-4111-8111-111111111111';
export const TENANT_B = '22222222-2222-4222-8222-222222222222';
export const OWNER = { email: 'owner@demo.opentradie.test', password: 'owner-password-for-tests' };
export const VIEWER = {
  email: 'viewer@demo.opentradie.test',
  password: 'viewer-password-for-tests',
};
export const ORIGIN = 'http://localhost:5173';

export function baseEnv(
  databaseUrl: string,
  overrides: Record<string, string> = {},
): NodeJS.ProcessEnv {
  return {
    DATABASE_URL: databaseUrl,
    SESSION_SECRET: 'test-session-secret-that-is-long-enough-0123456789',
    TENANT_ID: TENANT_A,
    APP_ORIGIN: ORIGIN,
    DEPLOYMENT_PROFILE: 'local',
    PRIVACY_MODE: 'LOCAL_ONLY',
    AGENT_MODE: 'mock',
    LOG_LEVEL: 'silent',
    ...overrides,
  };
}

export interface TestContext {
  app: App;
  db: Database;
  url: string;
  config: RuntimeConfig;
  fileStore: FileStore;
  /** The accounting runtime shared by the app (null when ACCOUNTING_PROVIDER is none). */
  accounting: AccountingRuntime | null;
  /** The mail runtime shared by the app (null when MAIL_PROVIDER is none). */
  mailRuntime: MailRuntime | null;
  logs: string[];
  close(): Promise<void>;
  login(who?: 'owner' | 'viewer'): Promise<string>;
  get(
    path: string,
    cookie: string,
  ): Promise<{ status: number; body: any; headers: Record<string, unknown> }>;
  send(
    method: 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    path: string,
    cookie: string,
    body?: unknown,
    options?: { key?: string; origin?: string | null },
  ): Promise<{ status: number; body: any; headers: Record<string, unknown> }>;
}

export async function createTestContext(
  options: {
    env?: Record<string, string>;
    runtime?: AgentRuntime;
    fileStore?: FileStore;
    embeddingProvider?: EmbeddingProvider | null;
    seedTenantB?: boolean;
    logLevel?: string;
    mail?: MailConnections;
    accountingOverrides?: AccountingRuntimeOverrides;
    mailOverrides?: MailRuntimeOverrides;
  } = {},
): Promise<TestContext> {
  const database = await createTestDatabase();
  const config = loadRuntimeConfig(
    baseEnv(database.url, {
      ...(options.logLevel ? { LOG_LEVEL: options.logLevel } : {}),
      ...options.env,
    }),
  );
  await seed(database.db, {
    tenantId: TENANT_A,
    ownerEmail: OWNER.email,
    ownerPassword: OWNER.password,
    viewerEmail: VIEWER.email,
    viewerPassword: VIEWER.password,
  });
  if (options.seedTenantB) {
    await seed(database.db, {
      tenantId: TENANT_B,
      ownerEmail: 'owner@other.test',
      ownerPassword: 'other-owner-password',
      businessName: 'Other Business (synthetic)',
    });
  }
  const fileStore =
    options.fileStore ?? new LocalFileStore(await mkdtemp(join(tmpdir(), 'opentradie-files-')));
  const logs: string[] = [];
  const logStream = new Writable({
    write(chunk, _encoding, callback) {
      logs.push(String(chunk));
      callback();
    },
  });
  const runtime = options.runtime ?? new MockAgentRuntime();
  const accounting = createAccountingRuntime(config, database.db, options.accountingOverrides);
  const mailRuntime = createMailRuntime(config, database.db, options.mailOverrides);
  const app = await buildApp({
    accounting,
    mailRuntime,
    db: database.db,
    runtime,
    config,
    fileStore,
    embeddingProvider: options.embeddingProvider ?? null,
    logStream,
    ...(options.mail ? { mail: options.mail } : {}),
  });
  await app.ready();

  const parse = (response: {
    statusCode: number;
    body: string;
    headers: Record<string, unknown>;
  }) => {
    let body: unknown;
    try {
      body = JSON.parse(response.body);
    } catch {
      body = response.body;
    }
    return { status: response.statusCode, body, headers: response.headers };
  };
  const context: TestContext = {
    app,
    db: database.db,
    url: database.url,
    config,
    fileStore,
    accounting,
    mailRuntime,
    logs,
    close: async () => {
      await app.close();
      await runtime.close();
      await database.drop();
    },
    login: async (who = 'owner') => {
      const credentials = who === 'owner' ? OWNER : VIEWER;
      const response = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: { origin: config.appOrigin },
        payload: credentials,
      });
      if (response.statusCode !== 200)
        throw new Error(`login failed: ${response.statusCode} ${response.body}`);
      const cookie = response.cookies.find((item) => item.name === 'opentradie_session');
      return `opentradie_session=${cookie!.value}`;
    },
    get: async (path, cookie) =>
      parse(await app.inject({ method: 'GET', url: path, headers: { cookie } })),
    send: async (method, path, cookie, body, sendOptions = {}) => {
      const headers: Record<string, string> = {
        cookie,
        'idempotency-key': sendOptions.key ?? randomUUID(),
      };
      if (sendOptions.origin !== null) headers.origin = sendOptions.origin ?? config.appOrigin;
      return parse(
        await app.inject({
          method,
          url: path,
          headers,
          ...(body === undefined ? {} : { payload: body as object }),
        }),
      );
    },
  };
  return context;
}

/** Customer id by name within a tenant, for tests. */
export async function customerId(db: Database, name: string, tenantId = TENANT_A): Promise<string> {
  const result = await db.pool.query<{ id: string }>(
    'SELECT id FROM customers WHERE tenant_id=$1 AND name=$2',
    [tenantId, name],
  );
  return result.rows[0]!.id;
}

/** Throwaway 32-byte key for tests only. */
export const TEST_CREDENTIAL_KEY = 'a'.repeat(64);
/** Environment for the fake (mock) accounting adapter. */
export const FAKE_ACCOUNTING_ENV = {
  ACCOUNTING_PROVIDER: 'fake',
  ACCOUNTING_ALLOW_FAKE: 'true',
  CREDENTIAL_ENCRYPTION_KEY: TEST_CREDENTIAL_KEY,
};

export function newKey(): string {
  return randomUUID();
}
