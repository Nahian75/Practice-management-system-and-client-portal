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
import { PaymentController } from './payment.controller.js';
import { PaymentDetailsCipher } from './payment-details-cipher.js';
import { PaymentRepository } from './payment.repository.js';
import { PaymentService } from './payment.service.js';
import { ReconciliationController } from './reconciliation.controller.js';
import { ReconciliationRepository } from './reconciliation.repository.js';
import { ReconciliationService } from './reconciliation.service.js';

@Module({
  imports: [DatabaseModule, AuditModule, AuthModule],
  controllers: [FinanceController, BillingController, LedgerController, PaymentController, ReconciliationController],
  providers: [
    {
      provide: BankAccountCipher,
      inject: [ENV],
      useFactory: (env: Env) => new BankAccountCipher(Buffer.from(env.FINANCE_ENCRYPTION_KEY, 'base64')),
    },
    {
      provide: PaymentDetailsCipher,
      inject: [ENV],
      useFactory: (env: Env) => new PaymentDetailsCipher(Buffer.from(env.FINANCE_ENCRYPTION_KEY, 'base64')),
    },
    FinanceRepository,
    FinanceService,
    PaymentRepository,
    PaymentService,
    ReconciliationRepository,
    ReconciliationService,
  ],
})
export class FinanceModule {}
