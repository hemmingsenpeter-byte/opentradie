import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { createHash } from 'node:crypto';
import type { S3Like } from '@opentradie/platform';

/**
 * In-memory stand-in for an S3-compatible service, used for contract tests only. It checks the
 * same request fields a real service would (bucket, key, SHA-256 checksum) but proves nothing
 * about network behaviour, auth or a specific vendor.
 */
export class InMemoryS3 implements S3Like {
  readonly objects = new Map<
    string,
    { body: Buffer; contentType: string | undefined; encryption: string | undefined }
  >();
  readonly commands: string[] = [];
  constructor(private readonly bucket: string) {}

  async send(
    command: PutObjectCommand | GetObjectCommand | HeadObjectCommand | DeleteObjectCommand,
  ): Promise<unknown> {
    this.commands.push(command.constructor.name);
    const input = command.input as { Bucket?: string; Key?: string };
    if (input.Bucket !== this.bucket)
      throw Object.assign(new Error('NoSuchBucket'), {
        name: 'NoSuchBucket',
        $metadata: { httpStatusCode: 404 },
      });
    const key = input.Key!;
    if (command instanceof PutObjectCommand) {
      const body = Buffer.from(command.input.Body as Buffer);
      const checksum = createHash('sha256').update(body).digest('base64');
      if (command.input.ChecksumSHA256 !== checksum)
        throw Object.assign(new Error('BadDigest'), {
          name: 'BadDigest',
          $metadata: { httpStatusCode: 400 },
        });
      this.objects.set(key, {
        body,
        contentType: command.input.ContentType,
        encryption: command.input.ServerSideEncryption,
      });
      return { $metadata: { httpStatusCode: 200 } };
    }
    const object = this.objects.get(key);
    if (command instanceof DeleteObjectCommand) {
      this.objects.delete(key);
      return { $metadata: { httpStatusCode: 204 } };
    }
    if (!object) {
      const name = command instanceof HeadObjectCommand ? 'NotFound' : 'NoSuchKey';
      throw Object.assign(new Error(name), { name, $metadata: { httpStatusCode: 404 } });
    }
    if (command instanceof HeadObjectCommand) return { ContentLength: object.body.length };
    return { Body: { transformToByteArray: async () => new Uint8Array(object.body) } };
  }
}
