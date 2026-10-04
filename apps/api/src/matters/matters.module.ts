import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { ClientsModule } from '../clients/clients.module.js';
import { DatabaseModule } from '../database/database.module.js';
import { MattersController } from './matters.controller.js';
import { MattersRepository } from './matters.repository.js';
import { MattersService } from './matters.service.js';

@Module({
  imports: [DatabaseModule, AuditModule, AuthModule, ClientsModule],
  controllers: [MattersController],
  providers: [MattersRepository, MattersService],
})
export class MattersModule {}
