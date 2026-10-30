import { secretBoxFor } from '../common/crypto/key-ring.js';
import { Inject, Injectable } from '@nestjs/common';
import { SecretBox, type SealedSecret } from '../common/crypto/secret-box.js';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';

export interface SealedHrData extends SealedSecret { context: string }

/** Encrypts structured personnel data with purpose-and-record-bound context. */
@Injectable()
export class HrDataCipher {
  private readonly box: SecretBox;

  constructor(@Inject(ENV) env: Env) {
    this.box = secretBoxFor(env, 'HR');
  }

  seal(value: unknown, context: string): SealedHrData {
    return { context, ...this.box.seal(Buffer.from(JSON.stringify(value), 'utf8'), context) };
  }

  open<T>(sealed: SealedHrData): T {
    return JSON.parse(this.box.open(sealed, sealed.context).toString('utf8')) as T;
  }
}
