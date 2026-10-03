import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { CLOCK, systemClock } from '../common/time/clock.js';
import { DatabaseModule } from '../database/database.module.js';
import { AuthController } from './auth.controller.js';
import { SessionGuard } from './sessions/session.guard.js';
import { SessionsRepository } from './sessions/sessions.repository.js';
import { SessionsService } from './sessions/sessions.service.js';

@Module({
  imports: [DatabaseModule, AuditModule],
  controllers: [AuthController],
  providers: [{ provide: CLOCK, useValue: systemClock }, SessionsRepository, SessionsService, SessionGuard],
  exports: [SessionsService, SessionGuard],
})
export class AuthModule {}
