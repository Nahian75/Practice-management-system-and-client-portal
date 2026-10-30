import { Module } from '@nestjs/common';
import {ScheduledJobsModule} from '../common/jobs/scheduled-jobs.js';
import { AuditModule } from '../audit/audit.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { DatabaseModule } from '../database/database.module.js';
import { DocumentsModule } from '../documents/documents.module.js';
import { AmlEvidenceVault } from './aml-evidence-vault.js';
import { AmlEvidenceIntake } from './aml-evidence-intake.js';
import { ComplianceDataCipher } from './compliance-data-cipher.js';
import { ComplianceController } from './compliance.controller.js';
import { ComplianceRepository } from './compliance.repository.js';
import { ComplianceService } from './compliance.service.js';
import { SanctionsScreeningService } from './sanctions-screening.service.js';
import { MoneyStatusController, SanctionsController } from './sanctions.controller.js';
import { SanctionsRepository } from './sanctions.repository.js';
import { SanctionsRefresher, SanctionsService } from './sanctions.service.js';
import { RestrictedReportsController } from './restricted-reports.controller.js';
import { RestrictedReportsRepository } from './restricted-reports.repository.js';
import { RestrictedReportsService } from './restricted-reports.service.js';
import { SuspicionDataCipher } from './suspicion-data-cipher.js';
import { SuspicionEvidenceVault } from './suspicion-evidence-vault.js';
import { RestrictedExportsController, RetentionController } from './retention.controller.js';
import { RetentionRepository } from './retention.repository.js';
import { RetentionService } from './retention.service.js';

@Module({
  imports: [DatabaseModule, AuditModule, AuthModule, DocumentsModule,ScheduledJobsModule],
  controllers: [ComplianceController, SanctionsController, MoneyStatusController, RestrictedReportsController,
    RetentionController, RestrictedExportsController],
  providers: [ComplianceRepository, ComplianceService, AmlEvidenceVault, AmlEvidenceIntake, ComplianceDataCipher,
    SanctionsRepository, SanctionsService, SanctionsRefresher, SanctionsScreeningService,
    RestrictedReportsRepository, RestrictedReportsService, SuspicionDataCipher, SuspicionEvidenceVault,
    RetentionRepository, RetentionService],
  exports: [AmlEvidenceVault, AmlEvidenceIntake, ComplianceDataCipher],
})
export class ComplianceModule {}
