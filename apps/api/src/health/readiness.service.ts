import { Inject, Injectable } from '@nestjs/common';
import { sql, type Kysely } from 'kysely';
import { DATABASE } from '../database/database.module.js';
import type { Database } from '../database/schema.js';
import { ObjectStorage } from '../documents/object-storage.js';
import { VirusScanner } from '../documents/virus-scanner.js';

@Injectable()
export class ReadinessService {
  private stopping=false;
  constructor(@Inject(DATABASE) private readonly db:Kysely<Database>,private readonly storage:ObjectStorage,private readonly scanner:VirusScanner) {}
  async ready():Promise<boolean> {
    if(this.stopping)return false;
    const database=this.db.transaction().execute(async trx=>{
      await sql`SET LOCAL statement_timeout='2s'`.execute(trx);
      await sql`SELECT 1`.execute(trx);
    });
    const results=await Promise.allSettled([database,this.storage.assertAvailable(),this.scanner.assertAvailable()]);
    return results.every(result=>result.status==='fulfilled');
  }
  beforeApplicationShutdown():void{this.stopping=true;}
}
