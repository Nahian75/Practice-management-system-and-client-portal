import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import { DatabaseModule } from '../database/database.module.js';
import { BankAccountCipher } from './bank-account-cipher.js';
import { FinanceController } from './finance.controller.js';
import { BillingController } from './billing.controller.js';
import { FinanceRepository } from './finance.repository.js';
import { FinanceService } from './finance.service.js';
import { LedgerController } from './ledger.controller.js';

@Module({
  imports: [DatabaseModule, AuditModule, AuthModule],
  controllers: [FinanceController, BillingController, LedgerController],
  providers: [
    {
      provide: BankAccountCipher,
      inject: [ENV],
      useFactory: (env: Env) => new BankAccountCipher(Buffer.from(env.FINANCE_ENCRYPTION_KEY, 'base64')),
    },
    FinanceRepository,
    FinanceService,
  ],
})
export class FinanceModule {}
