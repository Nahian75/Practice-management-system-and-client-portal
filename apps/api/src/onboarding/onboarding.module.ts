import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { DatabaseModule } from '../database/database.module.js';
import { MailModule } from '../mail/mail.module.js';
import { ComplianceModule } from '../compliance/compliance.module.js';
import { OnboardingController, PortalEvidenceController, PortalEngagementController, PortalPaymentController, PublicContactVerificationController } from './onboarding.controller.js';
import { OnboardingRepository } from './onboarding.repository.js';
import { OnboardingService } from './onboarding.service.js';

@Module({
  imports: [DatabaseModule, AuditModule, MailModule, ComplianceModule],
  controllers: [OnboardingController, PortalEvidenceController, PortalEngagementController, PortalPaymentController, PublicContactVerificationController],
  providers: [OnboardingRepository, OnboardingService],
})
export class OnboardingModule {}
