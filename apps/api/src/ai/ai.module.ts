import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module.js';
import { AI_PROVIDER_TOKEN } from './ai-provider.interface.js';
import { OfflineMockAiProvider } from './offline-mock-ai.provider.js';
import { AiRepository } from './ai.repository.js';
import { AiService } from './ai.service.js';
import { AiController } from './ai.controller.js';

@Module({
  imports: [DatabaseModule],
  controllers: [AiController],
  providers: [
    AiRepository,
    AiService,
    OfflineMockAiProvider,
    {
      provide: AI_PROVIDER_TOKEN,
      useExisting: OfflineMockAiProvider,
    },
  ],
  exports: [AiService, AiRepository],
})
export class AiModule {}
