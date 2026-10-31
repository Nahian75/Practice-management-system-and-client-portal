import {Body,Controller,Get,Param,Post,Query,Req} from '@nestjs/common';
import type {Request} from 'express';
import {z} from 'zod';
import {RequirePermission} from '../auth/permissions/require-permission.decorator.js';
import {auditActorFor,CurrentSession,type ResolvedSession} from '../auth/sessions/authenticated-session.js';
import {requestContext} from '../common/http/request-context.js';
import {ResponseSchema} from '../common/serialization/response-schema.decorator.js';
import {text} from '../common/validation/safe-text.js';
import {ExpensesService} from './expenses.service.js';
import {billAmountToPence} from './money.js';
const money=z.string().refine(v=>{try{billAmountToPence(v);return true;}catch{return false;}},'Enter an amount from 0.01 to 1000000.00 with two decimals').transform(billAmountToPence);
const body=z.strictObject({incurredOn:z.iso.date(),kind:z.enum(['recharge','disbursement']),description:text(1000),net:money,
 vatTreatment:z.enum(['standard','reduced','zero','exempt','outside_scope']),billable:z.boolean(),receiptVersionId:z.uuid().nullable(),requestId:z.uuid()});
const person=z.object({accountId:z.uuid(),displayName:z.string()});
const item=z.object({id:z.uuid(),matterId:z.uuid(),incurredOn:z.iso.date(),kind:z.enum(['recharge','disbursement']),description:z.string(),
 net:z.string(),vatTreatment:z.string(),billable:z.boolean(),receiptVersionId:z.uuid().nullable(),recordedAt:z.iso.datetime(),recordedBy:person,
 billId:z.uuid().nullable(),void:z.object({reason:z.string(),voidedAt:z.iso.datetime(),voidedBy:person}).nullable()});
const actor=(s:ResolvedSession,r:Request)=>({accountId:s.account.id,actor:auditActorFor(s.account),context:requestContext(r)});
@Controller('matters/:matterId/expenses')
export class ExpensesController{
 constructor(private readonly expenses:ExpensesService){}
 @Get('receipt-options') @RequirePermission('finance.matter.view') @ResponseSchema(z.object({receipts:z.array(z.object({id:z.uuid(),documentId:z.uuid(),title:z.string(),number:z.number().int()})),truncated:z.boolean()}))
 receipts(@Param('matterId',{schema:z.uuid()})matterId:string,@CurrentSession()s:ResolvedSession){return this.expenses.receipts(matterId,s.account.id);}
 @Get() @RequirePermission('finance.matter.view') @ResponseSchema(z.object({canRecord:z.boolean(),matterOpen:z.boolean(),expenses:z.array(item),next:z.uuid().nullable()}))
 list(@Param('matterId',{schema:z.uuid()})matterId:string,@Query({schema:z.strictObject({before:z.uuid().optional()})})q:{before?:string},@CurrentSession()s:ResolvedSession){return this.expenses.list(matterId,s.account.id,q.before);}
 @Post() @RequirePermission('expenses.record') @ResponseSchema(z.object({id:z.uuid()}))
 record(@Param('matterId',{schema:z.uuid()})matterId:string,@Body({schema:body})input:z.infer<typeof body>,@CurrentSession()s:ResolvedSession,@Req()r:Request){
  const {net,...details}=input;return this.expenses.record(matterId,{...details,netPence:net},actor(s,r));
 }
 @Post(':expenseId/void') @RequirePermission('expenses.record') @ResponseSchema(z.object({id:z.uuid()}))
 void(@Param('matterId',{schema:z.uuid()})matterId:string,@Param('expenseId',{schema:z.uuid()})expenseId:string,
  @Body({schema:z.strictObject({reason:text(500)})})input:{reason:string},@CurrentSession()s:ResolvedSession,@Req()r:Request){return this.expenses.void(matterId,expenseId,input.reason,actor(s,r));}
}
