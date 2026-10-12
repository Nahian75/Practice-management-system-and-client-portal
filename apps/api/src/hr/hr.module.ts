import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { DatabaseModule } from '../database/database.module.js';
import { DocumentsModule } from '../documents/documents.module.js';
import { HrController } from './hr.controller.js';
import { HrDataCipher } from './hr-data-cipher.js';
import { HrFileVault } from './hr-file-vault.js';
import { HrLeaveController } from './hr-leave.controller.js';
import { HrLeaveRepository } from './hr-leave.repository.js';
import { HrLeaveService } from './hr-leave.service.js';
import { HrRepository } from './hr.repository.js';
import { HrService } from './hr.service.js';

@Module({
  imports: [DatabaseModule, AuditModule, AuthModule, DocumentsModule],
  controllers: [HrController, HrLeaveController],
  providers: [HrRepository, HrService, HrDataCipher, HrFileVault, HrLeaveRepository, HrLeaveService],
})
export class HrModule {}
