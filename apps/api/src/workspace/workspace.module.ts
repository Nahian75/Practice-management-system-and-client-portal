import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { AuditModule } from '../audit/audit.module.js';
import { WorkspaceController } from './workspace.controller.js';
import { WorkspaceService } from './workspace.service.js';
import { WorkTimerController } from './work-timer.controller.js';
import { WorkTimerService } from './work-timer.service.js';

@Module({ imports: [DatabaseModule, AuthModule, AuditModule], controllers: [WorkspaceController, WorkTimerController], providers: [WorkspaceService, WorkTimerService] })
export class WorkspaceModule {}
