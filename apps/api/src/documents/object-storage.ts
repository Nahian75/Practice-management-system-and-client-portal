import type { Readable } from 'node:stream';
import { DeleteObjectCommand, GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { Inject, Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const STORAGE_KEY = new RegExp(`^(?:${UUID}|compliance/${UUID}|compliance/restricted/${UUID})$`);

export class ObjectNotFoundError extends Error {
  override readonly name = 'ObjectNotFoundError';
}

/**
 * The document bucket. It only ever holds encrypted bytes (`DocumentVault`
 * encrypts before calling this), under random ids that say nothing about the
 * file. Works with any S3-compatible storage; locally SeaweedFS.
 */
@Injectable()
export class ObjectStorage implements OnApplicationShutdown {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(@Inject(ENV) env: Env) {
    this.bucket = env.DOCUMENTS_S3_BUCKET;
    this.client = new S3Client({
      endpoint: env.DOCUMENTS_S3_ENDPOINT,
      region: env.DOCUMENTS_S3_REGION,
      // Bucket in the path, not the host name: what S3-compatible storage other than AWS expects.
      forcePathStyle: true,
      credentials: { accessKeyId: env.DOCUMENTS_S3_ACCESS_KEY, secretAccessKey: env.DOCUMENTS_S3_SECRET_KEY },
      // Integrity is the cipher's job (every chunk is authenticated); not every S3-compatible store accepts these checksums.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
  }

  /**
   * Streams `body` into the bucket in parts, so its length need not be known
   * in advance. `abort` cancels it, removing any parts already sent.
   */
  async put(key: string, body: Readable, abort?: AbortController): Promise<void> {
    await new Upload({
      client: this.client,
      params: { Bucket: this.bucket, Key: checked(key), Body: body },
      ...(abort ? { abortController: abort } : {}),
    }).done();
  }

  async get(key: string): Promise<Readable> {
    try {
      const { Body } = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: checked(key) }));
      return Body as Readable;
    } catch (error) {
      if (error instanceof Error && error.name === 'NoSuchKey') {
        throw new ObjectNotFoundError('No stored object with this key');
      }
      throw error;
    }
  }

  /** Removes an object, for an upload that was refused after its bytes were stored. */
  async remove(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: checked(key) }));
  }

  onApplicationShutdown(): void {
    this.client.destroy();
  }
}

function checked(key: string): string {
  if (!STORAGE_KEY.test(key)) {
    throw new Error('A storage key is a lower-case UUID in an approved private namespace');
  }
  return key;
}
