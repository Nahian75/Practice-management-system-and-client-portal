import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { DatabaseModule } from '../database/database.module.js';
import { DocumentsModule } from '../documents/documents.module.js';
import { AmlEvidenceVault } from './aml-evidence-vault.js';
import { ComplianceDataCipher } from './compliance-data-cipher.js';
import { ComplianceController } from './compliance.controller.js';
import { ComplianceRepository } from './compliance.repository.js';
import { ComplianceService } from './compliance.service.js';
import { SanctionsController } from './sanctions.controller.js';
import { SanctionsRepository } from './sanctions.repository.js';
import { SanctionsRefresher, SanctionsService } from './sanctions.service.js';

@Module({
  imports: [DatabaseModule, AuditModule, AuthModule, DocumentsModule],
  controllers: [ComplianceController, SanctionsController],
  providers: [ComplianceRepository, ComplianceService, AmlEvidenceVault, ComplianceDataCipher,
    SanctionsRepository, SanctionsService, SanctionsRefresher],
})
export class ComplianceModule {}
