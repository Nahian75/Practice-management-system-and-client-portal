import { Inject, Injectable } from '@nestjs/common';
import { SecretBox, type SealedSecret } from '../common/crypto/secret-box.js';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';

export interface SealedComplianceData extends SealedSecret { context: string }

/** Encrypts small AML payloads with purpose-and-record-bound authenticated encryption. */
@Injectable()
export class ComplianceDataCipher {
  private readonly box: SecretBox;
  constructor(@Inject(ENV) env: Env) { this.box = new SecretBox(Buffer.from(env.AML_ENCRYPTION_KEY, 'base64'), 1); }

  seal(value: unknown, context: string): SealedComplianceData {
    return { context, ...this.box.seal(Buffer.from(JSON.stringify(value), 'utf8'), context) };
  }

  open<T>(sealed: SealedComplianceData): T {
    return JSON.parse(this.box.open(sealed, sealed.context).toString('utf8')) as T;
  }
}
