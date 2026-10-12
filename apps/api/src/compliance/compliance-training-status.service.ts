import { Inject, Injectable, Module } from '@nestjs/common';
import { sql, type Kysely } from 'kysely';
import { DATABASE, DatabaseModule } from '../database/database.module.js';
import type { Database } from '../database/schema.js';

export interface AmlTrainingStatus {
  materialId: string; title: string; version: number; completedOn: string | null;
  dueOn: string; status: 'completed' | 'due' | 'expired';
}

@Injectable()
export class ComplianceTrainingStatusService {
  constructor(@Inject(DATABASE) private readonly db: Kysely<Database>) {}

  async forHr(personId: string, actorId: string): Promise<AmlTrainingStatus[]> {
    const result = await sql<{ material_id: string; title: string; version: number;
      completed_on: string | null; due_on: string; status: AmlTrainingStatus['status'] }>`
      select * from app.read_aml_training_status_for_hr(${personId}::uuid,${actorId}::uuid)`.execute(this.db);
    return result.rows.map((row) => ({ materialId: row.material_id,title: row.title,version: row.version,
      completedOn: row.completed_on,dueOn: row.due_on,status: row.status }));
  }
}

@Module({ imports:[DatabaseModule],providers:[ComplianceTrainingStatusService],exports:[ComplianceTrainingStatusService] })
export class ComplianceTrainingStatusModule {}
