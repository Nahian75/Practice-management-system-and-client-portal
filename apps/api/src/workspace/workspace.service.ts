import { Inject, Injectable, NotFoundException, ConflictException } from '@nestjs/common';
import { sql, type Kysely } from 'kysely';
import { DATABASE } from '../database/database.module.js';
import type { Database } from '../database/schema.js';
import { visibleTo } from '../matters/matters.repository.js';
import {visibleTo as clientVisibleTo,clientName} from '../clients/clients.repository.js';
import { AuditService } from '../audit/audit.service.js';
import type { TaskActor } from '../tasks/tasks.service.js';
import {metricPeriods,businessDate} from './workspace-metrics.js';

export interface WorkspaceFilter { q?: string; before?: string; status?: 'open'|'completed'|'cancelled'|'all'; assignee?: 'me'|'all'; from?: string; to?: string }
const PAGE_SIZE = 100;
function page<T extends { id: string }>(rows: T[]) { return { items: rows.slice(0,PAGE_SIZE), next: rows.length>PAGE_SIZE ? rows[PAGE_SIZE-1]!.id : null }; }

@Injectable()
export class WorkspaceService {
  constructor(@Inject(DATABASE) private readonly db: Kysely<Database>, private readonly audit: AuditService) {}

  async performance(viewer:string,scope:'personal'|'firm'='personal'){
    const periods=metricPeriods(businessDate());
    const preferences=scope==='personal'?await this.db.selectFrom('performance_preferences').select('daily_target_minutes').where('account_id','=',viewer).executeTakeFirst():undefined;
    const results=await Promise.all(periods.map(async period=>{
      const rows=await this.db.selectFrom('time_entries as t').innerJoin('matters','matters.id','t.matter_id')
        .leftJoin('issued_bill_lines as line','line.source_time_entry_id','t.id')
        .select([
          sql<string>`coalesce(sum(t.minutes),0)::text`.as('minutes'),
          sql<string>`coalesce(sum(CASE WHEN line.id IS NULL THEN round(t.minutes::numeric*t.hourly_rate_pence/60) ELSE 0 END),0)::text`.as('unbilledPence'),
          sql<string>`coalesce(sum(CASE WHEN line.id IS NOT NULL THEN line.net_pence ELSE 0 END),0)::text`.as('billedPence'),
        ]).where('t.voided','=',false).where('t.worked_on','>=',period.from).where('t.worked_on','<=',period.to)
        .$if(scope==='personal',query=>query.where('t.worker_id','=',viewer).where(visibleTo(viewer))).executeTakeFirstOrThrow();
      return {key:period.key,label:period.label,from:period.from,to:period.to,minutes:Number(rows.minutes),
        targetMinutes:preferences?.daily_target_minutes==null?null:preferences.daily_target_minutes*period.weekdays,
        billedPence:rows.billedPence,unbilledPence:rows.unbilledPence};
    }));
    return {scope,asOf:businessDate(),dailyTargetMinutes:preferences?.daily_target_minutes??null,periods:results};
  }

  async setTarget(viewer:string,minutes:number|null,by:TaskActor){
    await this.db.transaction().execute(async trx=>{
      await sql`INSERT INTO app.performance_preferences(account_id,daily_target_minutes) VALUES(${viewer}::uuid,${minutes})
        ON CONFLICT(account_id) DO UPDATE SET daily_target_minutes=EXCLUDED.daily_target_minutes`.execute(trx);
      await this.audit.record({actor:by.actor,action:'performance.target_changed',outcome:'success',resource:{type:'account',id:viewer},metadata:{dailyTargetMinutes:minutes},...by.context},trx);
    });
  }

  async billingMetrics(){
    const result=await sql<{draftCount:number;draftPence:string;issuedCount:number;issuedPence:string;creditCount:number;creditPence:string}>`
      WITH draft_totals AS (
        SELECT d.id,coalesce(sum(l.net_pence+CASE l.vat_treatment WHEN 'standard' THEN round(l.net_pence::numeric*20/100) WHEN 'reduced' THEN round(l.net_pence::numeric*5/100) ELSE 0 END),0) AS gross
        FROM app.bill_drafts d LEFT JOIN app.bill_draft_lines l ON l.draft_id=d.id
        WHERE NOT EXISTS(SELECT 1 FROM app.issued_bills b WHERE b.draft_id=d.id) GROUP BY d.id
      ) SELECT (SELECT count(*)::int FROM draft_totals) AS "draftCount",(SELECT coalesce(sum(gross),0)::text FROM draft_totals) AS "draftPence",
        (SELECT count(*)::int FROM app.issued_bills) AS "issuedCount",(SELECT coalesce(sum(gross_pence),0)::text FROM app.issued_bills) AS "issuedPence",
        (SELECT count(*)::int FROM app.credit_notes) AS "creditCount",(SELECT coalesce(sum(gross_pence),0)::text FROM app.credit_notes) AS "creditPence"`.execute(this.db);
    return result.rows[0]!;
  }

  async billingRecords(kind:'draft'|'issued'|'credit',before?:string){
    if(kind==='draft'){
      const result=await sql<{id:string;reference:string;matterId:string;matterReference:string;grossPence:string;date:string}>`
        SELECT d.id,m.reference AS reference,d.matter_id AS "matterId",m.reference AS "matterReference",
          coalesce(sum(l.net_pence+CASE l.vat_treatment WHEN 'standard' THEN round(l.net_pence::numeric*20/100) WHEN 'reduced' THEN round(l.net_pence::numeric*5/100) ELSE 0 END),0)::text AS "grossPence",d.tax_point AS date
        FROM app.bill_drafts d JOIN app.matters m ON m.id=d.matter_id LEFT JOIN app.bill_draft_lines l ON l.draft_id=d.id
        WHERE NOT EXISTS(SELECT 1 FROM app.issued_bills b WHERE b.draft_id=d.id) AND (${before??null}::uuid IS NULL OR d.id<${before??null}::uuid)
        GROUP BY d.id,m.reference ORDER BY d.id DESC LIMIT 101`.execute(this.db);
      return page(result.rows);
    }
    if(kind==='issued')return page(await this.db.selectFrom('issued_bills').select(['id','reference','matter_id as matterId','matter_reference as matterReference','gross_pence as grossPence','issued_on as date'])
      .$if(!!before,q=>q.where('id','<',before!)).orderBy('id','desc').limit(101).execute());
    return page(await this.db.selectFrom('credit_notes as c').innerJoin('issued_bills as b','b.id','c.bill_id').select(['c.id','c.reference','b.matter_id as matterId','b.matter_reference as matterReference','c.gross_pence as grossPence','c.issued_on as date'])
      .$if(!!before,q=>q.where('c.id','<',before!)).orderBy('c.id','desc').limit(101).execute());
  }

  async feed(){
    const rows=await this.db.selectFrom('audit_events').select(['id','action','outcome','occurred_at']).orderBy('id','desc').limit(30).execute();
    return {events:rows.map(row=>({id:row.id,action:row.action,outcome:row.outcome,occurredAt:row.occurred_at.toISOString()}))};
  }

  async search(viewer:string,q:string){
    const [matters,clients]=await Promise.all([
      this.db.selectFrom('matters').select(['id','reference','title']).where(visibleTo(viewer))
        .where(eb=>eb.or([eb('title','ilike',`%${q}%`),eb('reference','ilike',`%${q}%`)]))
        .orderBy('id','desc').limit(20).execute(),
      this.db.selectFrom('clients').leftJoin('client_individuals as i','i.client_id','clients.id').leftJoin('client_organisations as o','o.client_id','clients.id')
        .select(['clients.id','clients.reference',clientName.as('name')]).where(clientVisibleTo(viewer))
        .where(eb=>eb.or([eb(clientName,'ilike',`%${q}%`),eb('clients.reference','ilike',`%${q}%`)]))
        .orderBy('clients.id','desc').limit(20).execute(),
    ]);return {matters,clients};
  }

  async tasks(viewer: string, filter: WorkspaceFilter) {
    const rows=await this.db.selectFrom('tasks').innerJoin('matters','matters.id','tasks.matter_id')
      .innerJoin('accounts','accounts.id','tasks.assigned_to')
      .select(['tasks.id','tasks.title','tasks.status','tasks.priority','tasks.due_on as dueOn','tasks.matter_id as matterId',
        'matters.reference as matterReference','matters.title as matterTitle','accounts.display_name as assignee','tasks.assigned_to as assigneeId'])
      .where(visibleTo(viewer))
      .$if(!!filter.q,q=>q.where('tasks.title','ilike',`%${filter.q}%`))
      .$if(!!filter.status&&filter.status!=='all',q=>q.where('tasks.status','=',filter.status as 'open'|'completed'|'cancelled'))
      .$if(filter.assignee==='me',q=>q.where('tasks.assigned_to','=',viewer))
      .$if(!!filter.from,q=>q.where('tasks.due_on','>=',filter.from!))
      .$if(!!filter.to,q=>q.where('tasks.due_on','<=',filter.to!))
      .$if(!!filter.before,q=>q.where('tasks.id','<',filter.before!))
      .orderBy('tasks.id','desc').limit(PAGE_SIZE+1).execute();
    return page(rows);
  }

  async documents(viewer: string, filter: WorkspaceFilter) {
    const rows=await this.db.selectFrom('documents').innerJoin('matters','matters.id','documents.matter_id')
      .innerJoin('document_versions as v','v.document_id','documents.id')
      .select(['documents.id','documents.title','documents.category','documents.matter_id as matterId','documents.shared_with_client as sharedWithClient',
        'matters.reference as matterReference','matters.title as matterTitle','v.number as version','v.file_name as fileName','v.size_bytes as sizeBytes','v.uploaded_at as uploadedAt'])
      .where(visibleTo(viewer))
      .where(({not,exists,selectFrom})=>not(exists(selectFrom('document_withdrawals').select('document_withdrawals.id').whereRef('document_withdrawals.document_id','=','documents.id'))))
      .where('v.number','=',eb=>eb.selectFrom('document_versions as latest').select(e=>e.fn.max<number>('latest.number').as('latest')).whereRef('latest.document_id','=','documents.id'))
      .$if(!!filter.q,q=>q.where('documents.title','ilike',`%${filter.q}%`))
      .$if(!!filter.before,q=>q.where('documents.id','<',filter.before!))
      .orderBy('documents.id','desc').limit(PAGE_SIZE+1).execute();
    return page(rows.map(row=>({...row,uploadedAt:row.uploadedAt.toISOString()})));
  }

  async activities(viewer: string, filter: WorkspaceFilter) {
    const rows=await this.db.selectFrom('time_entries').innerJoin('matters','matters.id','time_entries.matter_id')
      .innerJoin('accounts','accounts.id','time_entries.worker_id')
      .select(['time_entries.id','time_entries.description','time_entries.worked_on as workedOn','time_entries.minutes','time_entries.voided',
        'time_entries.matter_id as matterId','matters.reference as matterReference','matters.title as matterTitle','accounts.display_name as worker'])
      .where(visibleTo(viewer))
      .$if(!!filter.q,q=>q.where('time_entries.description','ilike',`%${filter.q}%`))
      .$if(!!filter.from,q=>q.where('time_entries.worked_on','>=',filter.from!))
      .$if(!!filter.to,q=>q.where('time_entries.worked_on','<=',filter.to!))
      .$if(!!filter.before,q=>q.where('time_entries.id','<',filter.before!))
      .orderBy('time_entries.id','desc').limit(PAGE_SIZE+1).execute();
    return page(rows);
  }

  async events(viewer: string, from: string, to: string) {
    const result=await sql<{id:string;title:string;description:string|null;startsAt:Date;endsAt:Date;matterId:string|null;matterReference:string|null}>`
      SELECT e.id,e.title,e.description,e.starts_at AS "startsAt",e.ends_at AS "endsAt",e.matter_id AS "matterId",m.reference AS "matterReference"
      FROM app.calendar_events e LEFT JOIN app.matters m ON m.id=e.matter_id
      WHERE e.created_by=${viewer}::uuid AND e.starts_at<(${to}::date+1)::timestamp AT TIME ZONE 'Europe/London'
      AND e.ends_at>=${from}::date::timestamp AT TIME ZONE 'Europe/London'
      AND NOT EXISTS(SELECT 1 FROM app.calendar_event_cancellations c WHERE c.event_id=e.id)
      AND (e.matter_id IS NULL OR EXISTS(SELECT 1 FROM app.matter_team t WHERE t.matter_id=e.matter_id AND t.account_id=${viewer}::uuid AND t.removed_at IS NULL))
      ORDER BY e.starts_at,e.id LIMIT 501`.execute(this.db);
    return { events:result.rows.slice(0,500).map(e=>({...e,startsAt:e.startsAt.toISOString(),endsAt:e.endsAt.toISOString()})),truncated:result.rows.length>500 };
  }

  async createEvent(input:{title:string;description?:string|null;startsAt:string;endsAt:string;matterId?:string|null},by:TaskActor) {
    if(input.matterId&&!await this.db.selectFrom('matters').select('id').where('id','=',input.matterId).where(visibleTo(by.accountId)).executeTakeFirst()) throw new NotFoundException('No matter with this id');
    return this.db.transaction().execute(async trx=>{
      const {rows:[event]}=await sql<{id:string}>`INSERT INTO app.calendar_events(created_by,matter_id,title,description,starts_at,ends_at)
        VALUES(${by.accountId}::uuid,${input.matterId??null}::uuid,${input.title},${input.description??null},${input.startsAt}::timestamptz,${input.endsAt}::timestamptz) RETURNING id`.execute(trx);
      await this.audit.record({actor:by.actor,action:'calendar.created',outcome:'success',resource:{type:'calendar_event',id:event!.id},metadata:{hasMatter:!!input.matterId},...by.context},trx);
      return {id:event!.id};
    });
  }

  async cancelEvent(id:string,by:TaskActor) {
    return this.db.transaction().execute(async trx=>{
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`app.calendar:${id}`},0))`.execute(trx);
      const {rows}=await sql`SELECT id FROM app.calendar_events WHERE id=${id}::uuid AND created_by=${by.accountId}::uuid`.execute(trx);
      if(!rows.length)throw new NotFoundException('No calendar event with this id');
      const added=await sql`INSERT INTO app.calendar_event_cancellations(event_id,cancelled_by) VALUES(${id}::uuid,${by.accountId}::uuid) ON CONFLICT DO NOTHING RETURNING event_id`.execute(trx);
      if(!added.rows.length)throw new ConflictException('This event is already cancelled');
      await this.audit.record({actor:by.actor,action:'calendar.cancelled',outcome:'success',resource:{type:'calendar_event',id},metadata:{},...by.context},trx);
    });
  }
}
