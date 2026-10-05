import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { DatabaseModule } from '../database/database.module.js';
import { DocumentVault } from './document-vault.js';
import { DocumentsController } from './documents.controller.js';
import { DocumentsRepository } from './documents.repository.js';
import { DocumentsService } from './documents.service.js';
import { ObjectStorage } from './object-storage.js';
import { VirusScanner } from './virus-scanner.js';

@Module({
  imports: [DatabaseModule, AuditModule, AuthModule],
  controllers: [DocumentsController],
  providers: [DocumentsRepository, DocumentsService, DocumentVault, ObjectStorage, VirusScanner],
})
export class DocumentsModule {}
