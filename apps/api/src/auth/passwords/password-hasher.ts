import { argon2, randomBytes, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { Injectable } from '@nestjs/common';

const argon2Async = promisify(argon2);

export interface Argon2Parameters {
  /** Memory in KiB. */
  memory: number;
  passes: number;
  parallelism: number;
}

/** OWASP Password Storage Cheat Sheet minimum for Argon2id. */
export const CURRENT_PARAMETERS: Argon2Parameters = { memory: 19_456, passes: 2, parallelism: 1 };

const SALT_BYTES = 16;
const HASH_BYTES = 32;
const ARGON2_VERSION = 19;

// Stored parameters are read back from the database. Bounds stop a tampered
// row from making a single verification consume gigabytes or minutes.
const MAX_MEMORY_KIB = 262_144;
const MAX_PASSES = 10;
const MAX_PARALLELISM = 8;

const PHC_PATTERN =
  /^\$argon2id\$v=(\d+)\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/;

export class MalformedPasswordHashError extends Error {
  override readonly name = 'MalformedPasswordHashError';
}

interface ParsedHash {
  parameters: Argon2Parameters;
  salt: Buffer;
  hash: Buffer;
}

/**
 * Argon2id password hashing, stored in the standard PHC string format:
 * `$argon2id$v=19$m=19456,t=2,p=1$<salt>$<hash>`. The parameters travel with
 * each hash, so they can be raised later without breaking existing accounts.
 */
@Injectable()
export class PasswordHasher {
  async hash(password: string): Promise<string> {
    const salt = randomBytes(SALT_BYTES);
    const hash = await derive(password, salt, CURRENT_PARAMETERS);
    return encode(CURRENT_PARAMETERS, salt, hash);
  }

  async verify(password: string, storedHash: string): Promise<boolean> {
    const stored = parse(storedHash);
    const candidate = await derive(password, stored.salt, stored.parameters);
    return timingSafeEqual(candidate, stored.hash);
  }

  /** True when a hash was made with weaker parameters than today's and should be replaced on next sign-in. */
  needsRehash(storedHash: string): boolean {
    const { parameters } = parse(storedHash);
    return (
      parameters.memory < CURRENT_PARAMETERS.memory ||
      parameters.passes < CURRENT_PARAMETERS.passes ||
      parameters.parallelism < CURRENT_PARAMETERS.parallelism
    );
  }
}

function derive(password: string, salt: Buffer, parameters: Argon2Parameters): Promise<Buffer> {
  return argon2Async('argon2id', {
    message: Buffer.from(password.normalize('NFKC'), 'utf8'),
    nonce: salt,
    memory: parameters.memory,
    passes: parameters.passes,
    parallelism: parameters.parallelism,
    tagLength: HASH_BYTES,
  });
}

function encode(parameters: Argon2Parameters, salt: Buffer, hash: Buffer): string {
  const { memory, passes, parallelism } = parameters;
  return `$argon2id$v=${ARGON2_VERSION}$m=${memory},t=${passes},p=${parallelism}$${toBase64(salt)}$${toBase64(hash)}`;
}

function parse(storedHash: string): ParsedHash {
  const match = PHC_PATTERN.exec(storedHash);
  if (!match) {
    throw new MalformedPasswordHashError('Stored password hash is not a valid Argon2id PHC string');
  }

  const [, version = '', memory = '', passes = '', parallelism = '', salt = '', hash = ''] = match;
  const parameters = { memory: Number(memory), passes: Number(passes), parallelism: Number(parallelism) };

  if (
    Number(version) !== ARGON2_VERSION ||
    parameters.memory > MAX_MEMORY_KIB ||
    parameters.passes > MAX_PASSES ||
    parameters.parallelism > MAX_PARALLELISM
  ) {
    throw new MalformedPasswordHashError('Stored password hash has unsupported parameters');
  }

  const saltBytes = Buffer.from(salt, 'base64');
  const hashBytes = Buffer.from(hash, 'base64');
  if (saltBytes.length < SALT_BYTES || hashBytes.length !== HASH_BYTES) {
    throw new MalformedPasswordHashError('Stored password hash has an unexpected salt or hash length');
  }

  return { parameters, salt: saltBytes, hash: hashBytes };
}

function toBase64(bytes: Buffer): string {
  return bytes.toString('base64').replace(/=+$/, '');
}
