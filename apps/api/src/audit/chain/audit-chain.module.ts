import { Module } from '@nestjs/common';
import { AuthModule } from '../../auth/auth.module.js';
import { DatabaseModule } from '../../database/database.module.js';
import { AuditChainScheduler } from './audit-chain.scheduler.js';
import { AuditChainService } from './audit-chain.service.js';

@Module({
  imports: [DatabaseModule, AuthModule],
  providers: [AuditChainService, AuditChainScheduler],
})
export class AuditChainModule {}
