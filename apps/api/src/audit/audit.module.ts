import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module.js';
import { AuditRepository } from './audit.repository.js';
import { AuditService } from './audit.service.js';

@Module({
  imports: [DatabaseModule],
  providers: [AuditRepository, AuditService],
  exports: [AuditService],
})
export class AuditModule {}
