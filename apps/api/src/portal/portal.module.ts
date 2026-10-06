import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { DatabaseModule } from '../database/database.module.js';
import { PortalAccessController } from './portal-access.controller.js';
import { PortalRepository } from './portal.repository.js';
import { PortalService } from './portal.service.js';

@Module({
  imports: [DatabaseModule, AuditModule, AuthModule],
  controllers: [PortalAccessController],
  providers: [PortalRepository, PortalService],
})
export class PortalModule {}
