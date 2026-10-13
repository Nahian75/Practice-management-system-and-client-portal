import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module.js';
import { AuditModule } from '../audit/audit.module.js';
import { AI_PROVIDER_TOKEN } from './ai-provider.interface.js';
import { OfflineMockAiProvider } from './offline-mock-ai.provider.js';
import { RedactionService } from './redaction.service.js';
import { PromptBuilderService } from './prompt-builder.service.js';
import { AiRepository } from './ai.repository.js';
import { AiService } from './ai.service.js';
import { AiController } from './ai.controller.js';

@Module({
  imports: [DatabaseModule, AuditModule],
  controllers: [AiController],
  providers: [
    AiRepository,
    AiService,
    RedactionService,
    PromptBuilderService,
    OfflineMockAiProvider,
    {
      provide: AI_PROVIDER_TOKEN,
      useExisting: OfflineMockAiProvider,
    },
  ],
  exports: [AiService, AiRepository, RedactionService, PromptBuilderService],
})
export class AiModule {}
