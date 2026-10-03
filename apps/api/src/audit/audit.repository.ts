import { Inject, Injectable } from '@nestjs/common';
import type { Insertable, Kysely } from 'kysely';
import { DATABASE } from '../database/database.module.js';
import type { AuditEventsTable, Database } from '../database/schema.js';

@Injectable()
export class AuditRepository {
  constructor(@Inject(DATABASE) private readonly db: Kysely<Database>) {}

  async insert(row: Insertable<AuditEventsTable>, executor: Kysely<Database> = this.db): Promise<void> {
    await executor.insertInto('audit_events').values(row).execute();
  }
}
