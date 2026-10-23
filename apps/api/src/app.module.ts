import { Module, type DynamicModule } from '@nestjs/common';
import { AuditChainModule } from './audit/chain/audit-chain.module.js';
import { AuthModule } from './auth/auth.module.js';
import { ConfigModule } from './config/config.module.js';
import type { Env } from './config/env.js';
import { DatabaseModule } from './database/database.module.js';
import { DocumentsModule } from './documents/documents.module.js';
import { HealthModule } from './health/health.module.js';
import { MattersModule } from './matters/matters.module.js';
import { PortalModule } from './portal/portal.module.js';
import { ClientsModule } from './clients/clients.module.js';
import { StaffModule } from './staff/staff.module.js';
import { TasksModule } from './tasks/tasks.module.js';
import { NotificationsModule } from './notifications/notifications.module.js';
import { FinanceModule } from './finance/finance.module.js';
import { ComplianceModule } from './compliance/compliance.module.js';
import { HrModule } from './hr/hr.module.js';
import { OnboardingModule } from './onboarding/onboarding.module.js';
import { AiModule } from './ai/ai.module.js';

@Module({})
export class AppModule {
  static forRoot(env: Env): DynamicModule {
    return {
      module: AppModule,
      imports: [ConfigModule.forRoot(env), DatabaseModule, AuthModule, AuditChainModule, HealthModule, StaffModule, ClientsModule, MattersModule, DocumentsModule, PortalModule, NotificationsModule, TasksModule, FinanceModule, ComplianceModule, HrModule, OnboardingModule, AiModule],
    };
  }
}
