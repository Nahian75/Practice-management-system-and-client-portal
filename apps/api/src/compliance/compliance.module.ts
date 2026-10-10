import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { DatabaseModule } from '../database/database.module.js';
import { ComplianceController } from './compliance.controller.js';
import { ComplianceRepository } from './compliance.repository.js';
import { ComplianceService } from './compliance.service.js';

@Module({
  imports: [DatabaseModule, AuditModule, AuthModule],
  controllers: [ComplianceController],
  providers: [ComplianceRepository, ComplianceService],
})
export class ComplianceModule {}
