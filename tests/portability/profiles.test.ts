import { afterEach, describe, expect, it } from 'vitest';
import {
  claimInstallation,
  ConfigError,
  loadRuntimeConfig,
  S3FileStore,
} from '@opentradie/platform';
import { baseEnv, createTestContext, customerId, type TestContext } from '../helpers/app.js';
import { createTestDatabase } from '../helpers/db.js';
import { InMemoryS3 } from '../helpers/s3-fake.js';

const LOCAL_DB = 'postgres://u:p@127.0.0.1:5432/opentradie';
const cloudEnv = {
  DEPLOYMENT_PROFILE: 'cloud',
  APP_ORIGIN: 'https://app.example.test',
  SECURE_COOKIES: 'true',
  FILE_STORE: 's3',
  S3_BUCKET: 'opentradie-test',
  CREDENTIAL_ENCRYPTION_KEY: 'a'.repeat(64),
  PRIVACY_MODE: 'APPROVED_CLOUD',
};

describe('deployment profile configuration', () => {
  it('loads the same schema for every profile', () => {
    expect(loadRuntimeConfig(baseEnv(LOCAL_DB)).profile).toBe('local');
    expect(loadRuntimeConfig(baseEnv(LOCAL_DB, cloudEnv))).toMatchObject({
      profile: 'cloud',
      fileStore: { kind: 's3' },
      secureCookies: true,
    });
    expect(loadRuntimeConfig(baseEnv(LOCAL_DB, { DEPLOYMENT_PROFILE: 'hybrid' })).profile).toBe(
      'hybrid',
    );
  });

  it('refuses unsafe cloud settings', () => {
    expect(() =>
      loadRuntimeConfig(baseEnv(LOCAL_DB, { ...cloudEnv, APP_ORIGIN: 'http://app.example.test' })),
    ).toThrow(/HTTPS/);
    expect(() =>
      loadRuntimeConfig(baseEnv(LOCAL_DB, { ...cloudEnv, FILE_STORE: 'local' })),
    ).toThrow(/FILE_STORE=s3/);
    expect(() =>
      loadRuntimeConfig(baseEnv(LOCAL_DB, { ...cloudEnv, CREDENTIAL_ENCRYPTION_KEY: '' })),
    ).toThrow();
  });

  it('hybrid refuses a cloud database or a second, remote gateway', () => {
    expect(() =>
      loadRuntimeConfig(
        baseEnv('postgres://u:p@db.cloud-provider.example:5432/x', {
          DEPLOYMENT_PROFILE: 'hybrid',
        }),
      ),
    ).toThrow(/local authoritative database/);
    expect(() =>
      loadRuntimeConfig(
        baseEnv(LOCAL_DB, {
          DEPLOYMENT_PROFILE: 'hybrid',
          AGENT_MODE: 'openclaw',
          OPENCLAW_TOKEN: 't',
          OPENCLAW_URL: 'wss://gateway.cloud.example',
        }),
      ),
    ).toThrow(/single local gateway/);
    expect(
      loadRuntimeConfig(
        baseEnv('postgres://u:p@mac-mini.local:5432/x', { DEPLOYMENT_PROFILE: 'hybrid' }),
      ).profile,
    ).toBe('hybrid');
    expect(
      loadRuntimeConfig(
        baseEnv('postgres://u:p@192.168.1.20:5432/x', { DEPLOYMENT_PROFILE: 'hybrid' }),
      ).profile,
    ).toBe('hybrid');
  });

  it('only an authoritative runtime may start the API or worker', () => {
    expect(() => loadRuntimeConfig(baseEnv(LOCAL_DB, { AUTHORITATIVE_RUNTIME: 'false' }))).toThrow(
      ConfigError,
    );
  });
});

describe('one authoritative installation per database', () => {
  let drop: (() => Promise<void>) | undefined;
  afterEach(async () => drop?.());

  it('refuses a second installation, a profile change, or a competing gateway', async () => {
    const database = await createTestDatabase();
    drop = database.drop;
    await claimInstallation(database.db, {
      installationId: 'mac-mini-1',
      profile: 'hybrid',
      gatewayUrl: 'ws://127.0.0.1:18789',
    });
    await claimInstallation(database.db, {
      installationId: 'mac-mini-1',
      profile: 'hybrid',
      gatewayUrl: 'ws://127.0.0.1:18789',
    }); // same installation: API + worker
    await expect(
      claimInstallation(database.db, {
        installationId: 'cloud-copy',
        profile: 'hybrid',
        gatewayUrl: null,
      }),
    ).rejects.toThrow(/second authoritative runtime/);
    await expect(
      claimInstallation(database.db, {
        installationId: 'mac-mini-1',
        profile: 'cloud',
        gatewayUrl: null,
      }),
    ).rejects.toThrow(/migration/);
    await expect(
      claimInstallation(database.db, {
        installationId: 'mac-mini-1',
        profile: 'hybrid',
        gatewayUrl: 'wss://gateway.cloud.example',
      }),
    ).rejects.toThrow(/competing gateway/);
  });
});

describe('the same vertical slice under every profile', () => {
  let ctx: TestContext | undefined;
  afterEach(async () => {
    await ctx?.close();
    ctx = undefined;
  });

  const profiles: Array<[string, Record<string, string>, () => S3FileStore | undefined]> = [
    ['local', { DEPLOYMENT_PROFILE: 'local' }, () => undefined],
    [
      'cloud',
      cloudEnv,
      () => new S3FileStore(new InMemoryS3('opentradie-test'), 'opentradie-test'),
    ],
    ['hybrid', { DEPLOYMENT_PROFILE: 'hybrid' }, () => undefined],
  ];

  it.each(profiles)(
    '%s profile: enquiry -> clarification -> quote -> approval with identical results',
    async (profile, env, store) => {
      const fileStore = store();
      ctx = await createTestContext({ env, ...(fileStore ? { fileStore } : {}) });
      const health = await ctx.get('/health', '');
      expect(health.body.deployment.profile).toBe(profile);
      expect(health.body.fileStore).toEqual({ kind: fileStore ? 's3' : 'local', status: 'ok' });
      const owner = await ctx.login();
      const clarification = await ctx.send('POST', '/api/enquiries', owner, {
        text: 'Mrs Johnson needs two power points replaced.',
      });
      expect(clarification.body.status).toBe('clarification_required');
      const drafted = await ctx.send('POST', '/api/enquiries', owner, {
        text: 'Mrs Johnson needs two power points replaced.',
        customerId: await customerId(ctx.db, 'Mrs Johnson'),
      });
      expect(drafted.body.quote).toMatchObject({
        subtotalCents: 27_300,
        taxCents: 4_095,
        totalCents: 31_395,
      });
      const approved = await ctx.send(
        'POST',
        `/api/quotes/${drafted.body.quoteId}/approve`,
        owner,
        { version: 1 },
      );
      expect(approved.status).toBe(200);
      const key = (
        await ctx.db.pool.query('SELECT storage_key FROM documents WHERE id=$1', [
          approved.body.documentId,
        ])
      ).rows[0].storage_key;
      expect(await ctx.fileStore.exists(key)).toBe(true);
    },
  );
});
