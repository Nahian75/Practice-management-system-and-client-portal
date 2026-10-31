import {ConflictException,ForbiddenException,Inject,Injectable,NotFoundException} from '@nestjs/common';
import {sql,type Kysely} from 'kysely';
import {DATABASE} from '../database/database.module.js';
import type {Database} from '../database/schema.js';
import {AuditService} from '../audit/audit.service.js';
import {PermissionsService} from '../auth/permissions/permissions.service.js';
import {visibleTo} from '../matters/matters.repository.js';
import type {FinanceActor} from './finance.service.js';
import type {VatTreatment} from './finance.js';
import {penceToPounds} from './money.js';

export interface ExpenseInput {
 incurredOn:string; kind:'recharge'|'disbursement'; description:string; netPence:string;
 vatTreatment:VatTreatment; billable:boolean; receiptVersionId:string|null; requestId:string;
}

@Injectable()
export class ExpensesService {
 constructor(@Inject(DATABASE)private readonly db:Kysely<Database>,private readonly audit:AuditService,private readonly permissions:PermissionsService){}

 private async assertAccess(matterId:string,viewer:string,db:Kysely<Database>){
  const all=await this.permissions.has(viewer,'finance.view_all');
  const matter=await db.selectFrom('matters').select(['id','status']).where('id','=',matterId).$if(!all,q=>q.where(visibleTo(viewer))).executeTakeFirst();
  if(!matter)throw new NotFoundException('No matter with this id');
  return matter;
 }

 async list(matterId:string,viewer:string,before?:string){
  const matter=await this.assertAccess(matterId,viewer,this.db);
  const rows=await this.db.selectFrom('matter_expenses as e')
   .innerJoin('accounts as a','a.id','e.recorded_by')
   .leftJoin('matter_expense_voids as v','v.expense_id','e.id')
   .leftJoin('accounts as voider','voider.id','v.voided_by')
   .leftJoin('issued_bill_lines as line','line.source_expense_entry_id','e.id')
   .select(['e.id','e.matter_id','e.incurred_on','e.kind','e.description','e.net_pence','e.vat_treatment','e.billable',
    'e.receipt_version_id','e.recorded_at','e.recorded_by','a.display_name','v.reason','v.voided_at','v.voided_by',
    'voider.display_name as voider_name','line.bill_id'])
   .where('e.matter_id','=',matterId).$if(!!before,q=>q.where('e.id','<',before!)).orderBy('e.id','desc').limit(101).execute();
  const canRecord=await this.permissions.has(viewer,'expenses.record');
  return {canRecord,matterOpen:matter.status==='open',expenses:rows.slice(0,100).map(e=>({id:e.id,matterId:e.matter_id,incurredOn:e.incurred_on,kind:e.kind,
   description:e.description,net:penceToPounds(e.net_pence),vatTreatment:e.vat_treatment,billable:e.billable,
   receiptVersionId:e.receipt_version_id,recordedAt:e.recorded_at.toISOString(),recordedBy:{accountId:e.recorded_by,displayName:e.display_name},
   billId:e.bill_id,void:e.voided_at?{reason:e.reason!,voidedAt:e.voided_at.toISOString(),voidedBy:{accountId:e.voided_by!,displayName:e.voider_name!}}:null})),
   next:rows.length>100?rows[99]!.id:null};
 }

 async receipts(matterId:string,viewer:string){
  await this.assertAccess(matterId,viewer,this.db);
  if(!await this.permissions.has(viewer,'documents.view'))return {receipts:[],truncated:false};
  const matter=await this.db.selectFrom('matters').select('id').where('id','=',matterId).where(visibleTo(viewer)).executeTakeFirst();
  if(!matter)return {receipts:[],truncated:false};
  const rows=await this.db.selectFrom('documents as d').innerJoin('document_versions as v','v.document_id','d.id')
   .select(['v.id','d.id as documentId','d.title','v.number']).distinctOn('d.id').where('d.matter_id','=',matterId)
   .where(eb=>eb.not(eb.exists(eb.selectFrom('document_withdrawals as w').select('w.id').whereRef('w.document_id','=','d.id'))))
   .orderBy('d.id','desc').orderBy('v.number','desc').limit(101).execute();
  return {receipts:rows.slice(0,100),truncated:rows.length>100};
 }

 async record(matterId:string,input:ExpenseInput,by:FinanceActor){
  try{return await this.db.transaction().execute(async trx=>{
   await this.assertAccess(matterId,by.accountId,trx);
   await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`expense-request:${by.accountId}:${input.requestId}`},0))`.execute(trx);
   const existing=await trx.selectFrom('matter_expenses').select('id').where('recorded_by','=',by.accountId).where('request_id','=',input.requestId).executeTakeFirst();
   const {rows:[created]}=await sql<{id:string}>`SELECT app.record_matter_expense(${matterId}::uuid,${input.incurredOn}::date,
    ${input.kind},${input.description},${input.netPence}::bigint,${input.vatTreatment},${input.billable},
    ${input.receiptVersionId}::uuid,${input.requestId}::uuid,${by.accountId}::uuid) AS id`.execute(trx);
   if(!existing)await this.audit.record({actor:by.actor,action:'expense.recorded',outcome:'success',resource:{type:'matter_expense',id:created!.id},metadata:{matterId},...by.context},trx);
   return {id:created!.id};
  });}catch(error){return expenseError(error);}
 }

 async void(matterId:string,expenseId:string,reason:string,by:FinanceActor){
  try{return await this.db.transaction().execute(async trx=>{
   await this.assertAccess(matterId,by.accountId,trx);
   const expense=await trx.selectFrom('matter_expenses').select('id').where('id','=',expenseId).where('matter_id','=',matterId).executeTakeFirst();
   if(!expense)throw new NotFoundException('No expense with this id');
   await sql`SELECT app.void_matter_expense(${expenseId}::uuid,${reason},${by.accountId}::uuid)`.execute(trx);
   await this.audit.record({actor:by.actor,action:'expense.voided',outcome:'success',resource:{type:'matter_expense',id:expenseId},metadata:{matterId},...by.context},trx);
   return {id:expenseId};
  });}catch(error){return expenseError(error);}
 }
}

function expenseError(error:unknown):never{
 const code=(error as {code?:string}).code;
 if(code==='42501')throw new ForbiddenException('You cannot record or void expenses on this matter');
 if(code==='P0002')throw new NotFoundException('No expense or matter with this id');
 if(['23514','23505','23503','22003','22P02'].includes(code??''))throw new ConflictException('The expense cannot be saved. Check clearance, receipt, date, billing status and whether the request was already used');
 throw error;
}
