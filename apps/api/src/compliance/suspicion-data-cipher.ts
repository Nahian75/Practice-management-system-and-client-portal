import { secretBoxFor } from '../common/crypto/key-ring.js';
import { Inject, Injectable } from '@nestjs/common';
import { SecretBox, type SealedSecret } from '../common/crypto/secret-box.js';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';

export interface SealedSuspicionData extends SealedSecret { context: string }

/** A key boundary for material whose existence and content are restricted to nominated officers. */
@Injectable()
export class SuspicionDataCipher {
  private readonly box: SecretBox;

  constructor(@Inject(ENV) env: Env) {
    this.box = secretBoxFor(env, 'SUSPICION');
  }

  seal(value: unknown, context: string): SealedSuspicionData {
    return { context, ...this.box.seal(Buffer.from(JSON.stringify(value), 'utf8'), context) };
  }

  open<T>(sealed: SealedSuspicionData): T {
    return JSON.parse(this.box.open(sealed, sealed.context).toString('utf8')) as T;
  }
}
