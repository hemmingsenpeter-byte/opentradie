import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';

export interface StoredFile {
  key: string;
  sizeBytes: number;
  sha256: string;
}

export class FileStoreError extends Error {
  constructor(
    readonly code: 'INVALID_KEY' | 'NOT_FOUND' | 'UNAVAILABLE',
    message: string,
  ) {
    super(message);
    this.name = 'FileStoreError';
  }
}

/** Portable object storage. Keys are tenant-prefixed by callers: tenants/<tenantId>/... */
export interface FileStore {
  readonly kind: 'local' | 's3';
  put(key: string, body: Buffer, options: { contentType: string }): Promise<StoredFile>;
  get(key: string): Promise<Buffer>;
  exists(key: string): Promise<boolean>;
  delete(key: string): Promise<void>;
  health(): Promise<{ status: 'ok' | 'unavailable' }>;
}

export function validateKey(key: string): string {
  if (
    !/^[a-z0-9][a-z0-9/_.-]{0,511}$/i.test(key) ||
    key.split('/').some((part) => part === '' || part === '.' || part === '..')
  ) {
    throw new FileStoreError('INVALID_KEY', 'Invalid storage key.');
  }
  return key;
}

const sha256 = (body: Buffer) => createHash('sha256').update(body).digest('hex');

export class LocalFileStore implements FileStore {
  readonly kind = 'local' as const;
  private readonly root: string;
  constructor(root: string) {
    this.root = resolve(root);
  }
  private path(key: string): string {
    const path = resolve(this.root, validateKey(key));
    if (!path.startsWith(this.root + sep))
      throw new FileStoreError('INVALID_KEY', 'Invalid storage key.');
    return path;
  }
  async put(key: string, body: Buffer): Promise<StoredFile> {
    const path = this.path(key);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, body, { mode: 0o600 });
    await rename(temporary, path);
    return { key, sizeBytes: body.length, sha256: sha256(body) };
  }
  async get(key: string): Promise<Buffer> {
    try {
      return await readFile(this.path(key));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        throw new FileStoreError('NOT_FOUND', 'File not found.');
      throw error;
    }
  }
  async exists(key: string): Promise<boolean> {
    try {
      return (await stat(this.path(key))).isFile();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }
  async delete(key: string): Promise<void> {
    await rm(this.path(key), { force: true });
  }
  async health(): Promise<{ status: 'ok' | 'unavailable' }> {
    try {
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      return { status: 'ok' };
    } catch {
      return { status: 'unavailable' };
    }
  }
}

/** The subset of the AWS SDK v3 client this adapter uses; lets contract tests inject a fake. */
export interface S3Like {
  send(
    command: PutObjectCommand | GetObjectCommand | HeadObjectCommand | DeleteObjectCommand,
  ): Promise<unknown>;
}

/**
 * S3-compatible adapter (AWS S3, Cloudflare R2, MinIO, Backblaze B2). Contract-tested against an
 * in-memory fake only; it has not been integration-tested against a real bucket.
 */
export class S3FileStore implements FileStore {
  readonly kind = 's3' as const;
  constructor(
    private readonly client: S3Like,
    private readonly bucket: string,
  ) {}

  static fromConfig(config: {
    bucket: string;
    region: string;
    endpoint?: string;
    accessKeyId?: string;
    secretAccessKey?: string;
    forcePathStyle: boolean;
  }): S3FileStore {
    const client = new S3Client({
      region: config.region,
      forcePathStyle: config.forcePathStyle,
      ...(config.endpoint ? { endpoint: config.endpoint } : {}),
      ...(config.accessKeyId && config.secretAccessKey
        ? {
            credentials: {
              accessKeyId: config.accessKeyId,
              secretAccessKey: config.secretAccessKey,
            },
          }
        : {}),
    });
    return new S3FileStore(client, config.bucket);
  }

  async put(key: string, body: Buffer, options: { contentType: string }): Promise<StoredFile> {
    const digest = sha256(body);
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: validateKey(key),
        Body: body,
        ContentType: options.contentType,
        ChecksumSHA256: Buffer.from(digest, 'hex').toString('base64'),
        ServerSideEncryption: 'AES256',
      }),
    );
    return { key, sizeBytes: body.length, sha256: digest };
  }
  async get(key: string): Promise<Buffer> {
    try {
      const output = (await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: validateKey(key) }),
      )) as {
        Body?: { transformToByteArray(): Promise<Uint8Array> };
      };
      if (!output.Body) throw new FileStoreError('NOT_FOUND', 'File not found.');
      return Buffer.from(await output.Body.transformToByteArray());
    } catch (error) {
      throw notFound(error);
    }
  }
  async exists(key: string): Promise<boolean> {
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: validateKey(key) }));
      return true;
    } catch (error) {
      if (notFound(error) instanceof FileStoreError) return false;
      throw error;
    }
  }
  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: validateKey(key) }));
  }
  async health(): Promise<{ status: 'ok' | 'unavailable' }> {
    try {
      await this.exists('health/probe');
      return { status: 'ok' };
    } catch {
      return { status: 'unavailable' };
    }
  }
}

function notFound(error: unknown): unknown {
  if (error instanceof FileStoreError) return error;
  const name = (error as { name?: string } | null)?.name;
  const status = (error as { $metadata?: { httpStatusCode?: number } } | null)?.$metadata
    ?.httpStatusCode;
  if (name === 'NoSuchKey' || name === 'NotFound' || status === 404)
    return new FileStoreError('NOT_FOUND', 'File not found.');
  return error;
}

export function createFileStore(
  config:
    | { kind: 'local'; path: string }
    | ({ kind: 's3' } & Parameters<typeof S3FileStore.fromConfig>[0]),
): FileStore {
  return config.kind === 'local' ? new LocalFileStore(config.path) : S3FileStore.fromConfig(config);
}
