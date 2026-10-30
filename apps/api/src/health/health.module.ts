import { Module } from '@nestjs/common';
import { HealthController } from './health.controller.js';
import { ReadinessService } from './readiness.service.js';
import { DatabaseModule } from '../database/database.module.js';
import { DocumentsModule } from '../documents/documents.module.js';

@Module({
  imports:[DatabaseModule,DocumentsModule],
  providers:[ReadinessService],
  controllers: [HealthController],
})
export class HealthModule {}
