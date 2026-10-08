import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { DatabaseModule } from '../database/database.module.js';
import { FinanceController } from './finance.controller.js';
import { FinanceRepository } from './finance.repository.js';
import { FinanceService } from './finance.service.js';

@Module({
  imports: [DatabaseModule, AuditModule, AuthModule],
  controllers: [FinanceController],
  providers: [FinanceRepository, FinanceService],
})
export class FinanceModule {}
