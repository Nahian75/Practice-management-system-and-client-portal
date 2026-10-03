import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../audit/audit.service.js';
import { CLOCK, type Clock } from '../../common/time/clock.js';
import type { AccountKind } from '../../database/schema.js';
import { auditActorFor } from '../sessions/authenticated-session.js';
import {
  BACKUP_CODE_COUNT,
  generateBackupCode,
  hashBackupCode,
  normaliseBackupCode,
} from './backup-codes.js';
import { BackupCodesRepository } from './backup-codes.repository.js';

@Injectable()
export class BackupCodesService {
  constructor(
    private readonly repository: BackupCodesRepository,
    private readonly audit: AuditService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Issues a fresh set of codes, retiring any earlier ones. The returned codes
   * are shown to the user once; only their hashes are kept.
   */
  async issue(account: { id: string; kind: AccountKind }): Promise<string[]> {
    const codes = Array.from({ length: BACKUP_CODE_COUNT }, generateBackupCode);
    const hashes = codes.map((code) => hashBackupCode(normaliseBackupCode(code)!));

    await this.repository.replaceAll(account.id, hashes, this.clock.now());
    await this.audit.record({ actor: auditActorFor(account), action: 'auth.backup_codes_issued', outcome: 'success' });
    return codes;
  }

  /** Spends a backup code if it is valid and unused. Each code works once. */
  async redeem(accountId: string, input: string): Promise<boolean> {
    const normalised = normaliseBackupCode(input);
    return normalised !== undefined && this.repository.spend(accountId, hashBackupCode(normalised), this.clock.now());
  }

  remaining(accountId: string): Promise<number> {
    return this.repository.countUnspent(accountId);
  }
}
