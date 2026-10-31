import Link from 'next/link';
import {apiGet} from '@/lib/api';
import {formatCalendarDate} from '@/lib/format';
import {pounds,type ExpensePage,type ReceiptOption} from '@/lib/finance';
import {ExpenseForm,VoidExpenseForm} from './expense-form';

export async function ExpensesSection({matterId,open,before,paginationPath}:{matterId:string;open:boolean;before?:string;paginationPath?:string}){
 const [page,receipts]=await Promise.all([
  apiGet<ExpensePage>(`/matters/${matterId}/expenses`,{before}),
  apiGet<{receipts:ReceiptOption[];truncated:boolean}>(`/matters/${matterId}/expenses/receipt-options`),
 ]);
 if(page.status===403||page.status===404)return null;
 if(!page.body)throw new Error('Could not load expenses');
 const canChange=open&&page.body.matterOpen&&page.body.canRecord;
 return <section aria-labelledby="expenses-heading"><h2 id="expenses-heading">Expenses and disbursements</h2>
  {page.body.expenses.length===0?<p>No expenses recorded.</p>:<table className="table"><thead><tr><th scope="col">Date and expense</th><th scope="col">Net amount</th><th scope="col">Billing</th><th scope="col">Record</th></tr></thead><tbody>{page.body.expenses.map(e=><tr key={e.id}><td>{formatCalendarDate(e.incurredOn)}<br/>{e.description}<br/><span className="secondary">{e.kind} · {e.vatTreatment.replaceAll('_',' ')}</span></td><td>{pounds(e.net)}</td><td>{e.void?'Voided':e.billId?<Link href={`/finance/bills/${e.billId}`}>Billed</Link>:e.billable?'Unbilled':'Nonbillable'}{e.void&&<p>{e.void.reason} — {e.void.voidedBy.displayName}</p>}</td><td>{e.recordedBy.displayName}<br/>{e.receiptVersionId?'Receipt version attached':'No receipt'}{canChange&&!e.void&&!e.billId&&<VoidExpenseForm matterId={matterId} expenseId={e.id}/>}</td></tr>)}</tbody></table>}
  {page.body.next&&<p><Link href={`${paginationPath??`/finance/matters/${matterId}`}?expensesBefore=${page.body.next}`}>Older expenses</Link></p>}
  {canChange&&<><ExpenseForm matterId={matterId} receipts={receipts.body?.receipts??[]}/>{receipts.body?.receipts.length? <p><Link className="button button-secondary" href={`/documents/new?matter=${matterId}`}>Upload another receipt to the matter</Link></p>:<p className="secondary">Receipts can be attached after a member of the matter team uploads them through Documents.</p>}{receipts.body?.truncated&&<p>Only the most recent 100 documents are listed.</p>}</>}
 </section>;
}
