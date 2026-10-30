import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { AuditModule } from '../audit/audit.module.js';
import { WorkspaceController } from './workspace.controller.js';
import { WorkspaceService } from './workspace.service.js';

@Module({ imports: [DatabaseModule, AuthModule, AuditModule], controllers: [WorkspaceController], providers: [WorkspaceService] })
export class WorkspaceModule {}
