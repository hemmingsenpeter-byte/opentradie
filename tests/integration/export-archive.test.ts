import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTestContext,
  customerId,
  TENANT_A,
  TENANT_B,
  type TestContext,
} from '../helpers/app.js';

const dir = mkdtempSync(join(tmpdir(), 'opentradie-export-zip-'));

/** Python's zipfile in isolated mode: verifies every CRC and returns {name: hex contents}. */
function readZip(archive: Buffer): Record<string, string> {
  const path = join(dir, `${randomUUID()}.zip`);
  writeFileSync(path, archive);
  expect(execFileSync('unzip', ['-t', path], { encoding: 'utf8' })).toMatch(/No errors detected/);
  const script =
    'import zipfile,sys,json\nz=zipfile.ZipFile(sys.argv[1])\nassert z.testzip() is None\n' +
    'print(json.dumps({i.filename: z.read(i).hex() for i in z.infolist()}))';
  return JSON.parse(execFileSync('python3', ['-I', '-c', script, path], { encoding: 'utf8' }));
}
const text = (hex: string | undefined) => Buffer.from(hex ?? '', 'hex').toString('utf8');

describe('export archives with file contents (ADR 0025 amendment)', () => {
  let ctx: TestContext;
  let owner: string;
  let margaret: string;
  const docs: Record<string, { id: string; body: string }> = {};

  async function addDocument(
    label: string,
    tenantId: string,
    customer: string | null,
    fileName: string,
    body: string,
  ) {
    const id = randomUUID();
    const key = `${tenantId}/files/${id}.bin`;
    const stored = await ctx.fileStore.put(key, Buffer.from(body), {
      contentType: 'application/octet-stream',
    });
    await ctx.db.pool.query(
      "INSERT INTO documents(id,tenant_id,customer_id,kind,storage_key,file_name,media_type,size_bytes,sha256) VALUES($1,$2,$3,'attachment',$4,$5,'application/octet-stream',$6,$7)",
      [id, tenantId, customer, key, fileName, stored.sizeBytes, stored.sha256],
    );
    docs[label] = { id, body };
  }

  const fetchZip = async (url: string, cookie: string) =>
    ctx.app.inject({ method: 'GET', url, headers: { cookie } });

  beforeAll(async () => {
    ctx = await createTestContext({ seedTenantB: true });
    owner = await ctx.login();
    margaret = await customerId(ctx.db, 'Mrs Johnson');
    const other = (
      await ctx.db.pool.query<{ id: string }>(
        'SELECT id FROM customers WHERE tenant_id=$1 AND id<>$2 LIMIT 1',
        [TENANT_A, margaret],
      )
    ).rows[0]!.id;
    const foreign = (
      await ctx.db.pool.query<{ id: string }>(
        'SELECT id FROM customers WHERE tenant_id=$1 LIMIT 1',
        [TENANT_B],
      )
    ).rows[0]!.id;
    await addDocument(
      'margaret',
      TENANT_A,
      margaret,
      'Kauri St — lounge/../ü.jpg',
      'margaret photo',
    );
    await addDocument('other', TENANT_A, other, 'other.pdf', 'other customer file');
    await addDocument('foreign', TENANT_B, foreign, 'foreign.pdf', 'tenant b secret file');
    await addDocument('erased', TENANT_A, margaret, '[erased]', 'gone');
    await ctx.fileStore.delete(`${TENANT_A}/files/${docs.erased!.id}.bin`);
  });
  afterAll(async () => {
    await ctx?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('streams the business export with every tenant file and a sha256 manifest', async () => {
    const response = await fetchZip('/api/export?format=zip', owner);
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('application/zip');
    expect(response.headers['content-disposition']).toMatch(/opentradie-export-.*\.zip"$/);
    const files = readZip(response.rawPayload);
    const bundle = JSON.parse(text(files['export.json']));
    expect(bundle).toMatchObject({
      format: 'opentradie-business-export',
      files: { included: true },
    });
    const manifest = JSON.parse(text(files['manifest.json']));
    const rows = bundle.tables.documents.rows as { id: string; sha256: string }[];
    expect(manifest.files).toHaveLength(rows.length - 1);
    expect(manifest.omitted).toEqual([{ documentId: docs.erased!.id, reason: 'erased' }]);
    for (const entry of manifest.files) {
      const row = rows.find((candidate) => candidate.id === entry.documentId)!;
      expect(entry.sha256).toBe(row.sha256);
      expect(files[entry.path], entry.path).toBeDefined();
    }
    const paths = Object.keys(files);
    expect(paths).toContain(`files/${docs.margaret!.id}-Kauri St _ lounge_.._ü.jpg`);
    expect(text(files[`files/${docs.other!.id}-other.pdf`])).toBe('other customer file');
    expect(paths.some((path) => path.includes(docs.foreign!.id))).toBe(false);
    expect(Object.values(files).map(text).join()).not.toContain('tenant b secret');
    const audit = (await ctx.get('/api/audit-events', owner)).body.auditEvents;
    expect(audit[0]).toMatchObject({ action: 'business.exported' });
  });

  it('limits the customer archive to that customer, and keeps JSON as the default', async () => {
    const response = await fetchZip(`/api/customers/${margaret}/export?format=zip`, owner);
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-disposition']).toMatch(/opentradie-customer-.*\.zip"$/);
    const files = readZip(response.rawPayload);
    const fileEntries = Object.keys(files).filter((path) => path.startsWith('files/'));
    expect(fileEntries).toEqual([`files/${docs.margaret!.id}-Kauri St _ lounge_.._ü.jpg`]);
    expect(text(files[fileEntries[0]!])).toBe('margaret photo');
    const manifest = JSON.parse(text(files['manifest.json']));
    expect(manifest.files[0]).toMatchObject({ documentId: docs.margaret!.id, sizeBytes: 14 });
    expect(JSON.parse(text(files['export.json'])).customerId).toBe(margaret);
    const json = await ctx.get(`/api/customers/${margaret}/export`, owner);
    expect(json.headers['content-type']).toMatch(/application\/json/);
  });

  it('refuses viewers and unknown formats', async () => {
    const viewer = await ctx.login('viewer');
    expect((await fetchZip('/api/export?format=zip', viewer)).statusCode).toBe(403);
    expect(
      (await fetchZip(`/api/customers/${margaret}/export?format=zip`, viewer)).statusCode,
    ).toBe(403);
    expect((await fetchZip('/api/export?format=tar', owner)).statusCode).toBe(400);
  });

  it('never hands out a complete archive when a stored file fails its checksum', async () => {
    await ctx.fileStore.put(`${TENANT_A}/files/${docs.other!.id}.bin`, Buffer.from('tampered!'), {
      contentType: 'application/octet-stream',
    });
    // Either the injected request fails (stream destroyed) or the payload is truncated.
    const payload = await fetchZip('/api/export?format=zip', owner).then(
      (response) => response.rawPayload,
      () => null,
    );
    if (payload) {
      const path = join(dir, 'tampered.zip');
      writeFileSync(path, payload);
      expect(() => execFileSync('unzip', ['-t', path], { stdio: 'pipe' })).toThrow();
      expect(payload.toString('latin1')).not.toContain('tampered!');
    }
  });
});
