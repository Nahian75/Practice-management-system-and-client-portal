import { randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../audit/audit.service.js';
import { CLOCK, type Clock } from '../../common/time/clock.js';
import type { AccountKind } from '../../database/schema.js';
import { auditActorFor } from '../sessions/authenticated-session.js';
import { SecretBox } from './secret-box.js';
import { TotpCredentialsRepository } from './totp-credentials.repository.js';
import { matchTotp, otpauthUri, TOTP_SECRET_BYTES, toBase32 } from './totp.js';

export const TOTP_ISSUER = 'Practice Portal';

export interface TwoFactorEnrolment {
  /** For typing into the app by hand. Shown once, never stored in readable form. */
  secret: string;
  /** For the QR code. */
  uri: string;
}

export class AlreadyEnrolledError extends Error {
  override readonly name = 'AlreadyEnrolledError';
}

interface EnrollingAccount {
  id: string;
  kind: AccountKind;
  email: string;
}

@Injectable()
export class TwoFactorService {
  constructor(
    private readonly credentials: TotpCredentialsRepository,
    private readonly secretBox: SecretBox,
    private readonly audit: AuditService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** Creates a new secret for the account to add to its authenticator app. Not active until confirmed. */
  async beginEnrolment(account: EnrollingAccount): Promise<TwoFactorEnrolment> {
    const secret = randomBytes(TOTP_SECRET_BYTES);
    const stored = await this.credentials.storePending(
      account.id,
      this.secretBox.seal(secret, account.id),
      this.clock.now(),
    );
    if (!stored) {
      throw new AlreadyEnrolledError('Account already has two-factor authentication');
    }
    return { secret: toBase32(secret), uri: otpauthUri(secret, TOTP_ISSUER, account.email) };
  }

  /** Activates the pending secret once the account proves its app produces the right code. */
  async confirmEnrolment(account: EnrollingAccount, code: string): Promise<boolean> {
    const credential = await this.credentials.find(account.id);
    if (!credential || credential.confirmed) {
      return false;
    }

    const now = this.clock.now();
    const step = matchTotp(this.secretBox.open(credential.sealed, account.id), code, now, null);
    if (step === undefined || !(await this.credentials.confirm(account.id, step, now))) {
      return false;
    }

    await this.audit.record({ actor: auditActorFor(account), action: 'auth.two_factor_enrolled', outcome: 'success' });
    return true;
  }

  async isEnrolled(accountId: string): Promise<boolean> {
    return (await this.credentials.find(accountId))?.confirmed === true;
  }

  /** Checks a sign-in code. Each code is accepted at most once. */
  async verify(accountId: string, code: string): Promise<boolean> {
    const credential = await this.credentials.find(accountId);
    if (!credential?.confirmed) {
      return false;
    }

    const secret = this.secretBox.open(credential.sealed, accountId);
    const step = matchTotp(secret, code, this.clock.now(), credential.lastUsedStep);
    return step !== undefined && (await this.credentials.markStepUsed(accountId, step));
  }
}
