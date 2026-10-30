import {Inject,Injectable,Module} from '@nestjs/common';
import {sql,type Kysely} from 'kysely';
import {DATABASE,DatabaseModule} from '../../database/database.module.js';
import type {Database} from '../../database/schema.js';

@Injectable()
export class ScheduledJobs {
  constructor(@Inject(DATABASE)private readonly db:Kysely<Database>){}

  async runDue(name:string,intervalSeconds:number,work:()=>Promise<boolean>):Promise<'ran'|'skipped'>{
    if(!/^[a-z][a-z0-9_-]{2,63}$/.test(name)||!Number.isInteger(intervalSeconds)||intervalSeconds<1||intervalSeconds>86400)throw new Error('Invalid scheduled job');
    // A dedicated session is essential: transaction-mode pooling is unsupported.
    return this.db.connection().execute(async connection=>{
      const {rows:[lock]}=await sql<{acquired:boolean}>`SELECT pg_try_advisory_lock(hashtextextended(${`app.scheduled:${name}`},0)) AS acquired`.execute(connection);
      if(!lock!.acquired)return 'skipped';
      try{
        const {rows:[due]}=await sql<{due:boolean}>`SELECT app.scheduled_job_due(${name}) AS due`.execute(connection);
        if(!due!.due)return 'skipped';
        try{
          const succeeded=await work();
          await sql`SELECT app.defer_scheduled_job(${name},${succeeded?intervalSeconds:60})`.execute(connection);
          return 'ran';
        }catch(error){
          await sql`SELECT app.defer_scheduled_job(${name},60)`.execute(connection);
          throw error;
        }
      }finally{
        await sql`SELECT pg_advisory_unlock(hashtextextended(${`app.scheduled:${name}`},0))`.execute(connection);
      }
    });
  }
}

@Module({imports:[DatabaseModule],providers:[ScheduledJobs],exports:[ScheduledJobs]})
export class ScheduledJobsModule{}
