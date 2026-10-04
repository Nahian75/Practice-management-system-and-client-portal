import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { DatabaseModule } from '../database/database.module.js';
import { StaffController } from './staff.controller.js';
import { StaffRepository } from './staff.repository.js';
import { StaffService } from './staff.service.js';

@Module({
  imports: [DatabaseModule, AuditModule, AuthModule],
  controllers: [StaffController],
  providers: [StaffRepository, StaffService],
})
export class StaffModule {}
