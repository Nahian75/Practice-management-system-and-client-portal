import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { DatabaseModule } from '../database/database.module.js';
import { DocumentsModule } from '../documents/documents.module.js';
import { ComplianceTrainingStatusModule } from '../compliance/compliance-training-status.service.js';
import { HrCompetenceController } from './hr-competence.controller.js';
import { HrCompetenceRepository } from './hr-competence.repository.js';
import { HrCompetenceService } from './hr-competence.service.js';
import { HrCasesRetentionController } from './hr-cases-retention.controller.js';
import { HrCasesRetentionRepository } from './hr-cases-retention.repository.js';
import { HrCasesRetentionService } from './hr-cases-retention.service.js';
import { HrController } from './hr.controller.js';
import { HrDataCipher } from './hr-data-cipher.js';
import { HrFileVault } from './hr-file-vault.js';
import { HrLeaveController } from './hr-leave.controller.js';
import { HrLeaveRepository } from './hr-leave.repository.js';
import { HrLeaveService } from './hr-leave.service.js';
import { HrRepository } from './hr.repository.js';
import { HrService } from './hr.service.js';
import { HrVettingController } from './hr-vetting.controller.js';
import { HrVettingRepository } from './hr-vetting.repository.js';
import { HrVettingService } from './hr-vetting.service.js';

@Module({
  imports: [DatabaseModule, AuditModule, AuthModule, DocumentsModule, ComplianceTrainingStatusModule],
  controllers: [HrController, HrLeaveController, HrVettingController, HrCompetenceController, HrCasesRetentionController],
  providers: [HrRepository, HrService, HrDataCipher, HrFileVault, HrLeaveRepository, HrLeaveService,
    HrVettingRepository, HrVettingService, HrCompetenceRepository, HrCompetenceService,
    HrCasesRetentionRepository, HrCasesRetentionService],
})
export class HrModule {}
