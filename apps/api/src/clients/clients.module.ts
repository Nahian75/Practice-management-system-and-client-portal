import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { DatabaseModule } from '../database/database.module.js';
import { ClientsController } from './clients.controller.js';
import { ClientsRepository } from './clients.repository.js';
import { ClientsService } from './clients.service.js';
import { SearchQuota } from './search-quota.js';

@Module({
  imports: [DatabaseModule, AuditModule, AuthModule],
  controllers: [ClientsController],
  providers: [ClientsRepository, ClientsService, SearchQuota],
  exports: [SearchQuota],
})
export class ClientsModule {}
