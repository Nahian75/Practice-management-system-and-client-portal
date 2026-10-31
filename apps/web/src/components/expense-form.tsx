'use client';
import {useRouter} from 'next/navigation';
import {useRef,useState,type FormEvent} from 'react';
import {ErrorSummary} from './error-summary';
import {messagesOf,postJson} from '@/lib/requests';
import type {ReceiptOption} from '@/lib/finance';

export function ExpenseForm({matterId,receipts}:{matterId:string;receipts:ReceiptOption[]}){
 const router=useRouter(),requestId=useRef<string|null>(null);
 const [busy,setBusy]=useState(false),[errors,setErrors]=useState<string[]>(),[saved,setSaved]=useState(false);
 async function submit(event:FormEvent<HTMLFormElement>){
  event.preventDefault();const element=event.currentTarget,data=new FormData(element);
  requestId.current??=crypto.randomUUID();setBusy(true);setErrors(undefined);setSaved(false);
  try{
   const response=await postJson(`/api/matters/${matterId}/expenses`,{requestId:requestId.current,
    incurredOn:String(data.get('incurredOn')),kind:String(data.get('expenseKind')),description:String(data.get('expenseDescription')).trim(),
    net:String(data.get('expenseNet')).trim(),vatTreatment:String(data.get('expenseVat')),billable:data.get('billable')==='on',receiptVersionId:String(data.get('receiptVersionId'))||null});
   if(!response.ok){setErrors(await messagesOf(response));return;}
   requestId.current=null;element.reset();setSaved(true);window.dispatchEvent(new Event('stass-expense-changed'));router.refresh();
  }catch{setErrors(['Could not confirm the save. Retry the same details; the request will not create a duplicate.']);}
  finally{setBusy(false);}
 }
 return <form onSubmit={submit} aria-labelledby="expense-form-heading"><h3 id="expense-form-heading">Record an expense</h3>
  <p className="secondary">Record a cost for this matter. This does not move client money or post a bank payment.</p>
  {errors&&<ErrorSummary messages={errors}/>} {saved&&<p role="status" className="notice">Expense recorded.</p>}
  <div className="field"><label className="label" htmlFor="incurredOn">Expense date</label><input className="input" type="date" id="incurredOn" name="incurredOn" required/></div>
  <div className="field"><label className="label" htmlFor="expenseKind">Expense type</label><select className="select" id="expenseKind" name="expenseKind"><option value="recharge">Recharge</option><option value="disbursement">Disbursement</option></select></div>
  <div className="field"><label className="label" htmlFor="expenseDescription">Expense description</label><textarea className="input" id="expenseDescription" name="expenseDescription" maxLength={1000} required/></div>
  <div className="field"><label className="label" htmlFor="expenseNet">Expense net amount in GBP</label><input className="input" id="expenseNet" name="expenseNet" inputMode="decimal" placeholder="25.00" required/></div>
  <div className="field"><label className="label" htmlFor="expenseVat">Expense VAT treatment</label><select className="select" id="expenseVat" name="expenseVat"><option value="standard">Standard 20%</option><option value="reduced">Reduced 5%</option><option value="zero">Zero-rated</option><option value="exempt">Exempt</option><option value="outside_scope">Outside scope</option></select></div>
  <div className="checkbox"><label><input type="checkbox" name="billable" defaultChecked/>Billable to the client</label></div>
  <div className="field"><label className="label" htmlFor="receiptVersionId">Receipt (optional)</label><select className="select" id="receiptVersionId" name="receiptVersionId"><option value="">No receipt attached</option>{receipts.map(r=><option key={r.id} value={r.id}>{r.title} — version {r.number}</option>)}</select><p className="hint">Choose a document you can access on this matter. Its exact version remains linked to the expense.</p></div>
  <button className="button" disabled={busy}>{busy?'Recording…':'Record expense'}</button>
 </form>;
}

export function VoidExpenseForm({matterId,expenseId}:{matterId:string;expenseId:string}){
 const router=useRouter();const[busy,setBusy]=useState(false),[errors,setErrors]=useState<string[]>();
 async function submit(event:FormEvent<HTMLFormElement>){event.preventDefault();const data=new FormData(event.currentTarget);setBusy(true);setErrors(undefined);
  try{const response=await postJson(`/api/matters/${matterId}/expenses/${expenseId}/void`,{reason:String(data.get('reason')).trim()});if(!response.ok){setErrors(await messagesOf(response));return;}window.dispatchEvent(new Event('stass-expense-changed'));router.refresh();}
  catch{setErrors(['Could not confirm the void. Reload the expense before trying again.']);}finally{setBusy(false);}
 }
 return <details><summary>Void expense</summary><form onSubmit={submit} aria-label="Void expense">{errors&&<ErrorSummary messages={errors}/>}<div className="field"><label className="label" htmlFor={`void-${expenseId}`}>Reason for void</label><input className="input" id={`void-${expenseId}`} name="reason" maxLength={500} required/></div><button className="button button-secondary" disabled={busy}>{busy?'Saving…':'Confirm void'}</button></form></details>;
}
