import Link from 'next/link';
import {apiGet} from '@/lib/api';
import {WorkspaceHeading,WorkspaceEmpty} from '@/components/workspace-page';
import {NoAccess} from '@/components/no-access';
import {formatCalendarDate} from '@/lib/format';
import type {WorkspacePage} from '@/lib/workspace';
export const metadata={title:'Billing'};
type BillingRecord={id:string;reference:string;matterId:string;matterReference:string;grossPence:string;date:string};
export default async function Page({searchParams}:{searchParams:Promise<{kind?:string;before?:string}>}){
 const params=await searchParams;const kind=params.kind==='draft'||params.kind==='credit'?params.kind:'issued';const before=typeof params.before==='string'?params.before:undefined;
 const result=await apiGet<WorkspacePage<BillingRecord>>('/workspace/billing-records',{kind,before});if(result.status===403)return <NoAccess what="firm billing"/>;
 const path=kind==='draft'?'bill-drafts':kind==='credit'?'credit-notes':'bills';
 return <><WorkspaceHeading title="Billing" description="Review draft bills, issued invoices and credit notes."/><nav className="workspace-tabs" aria-label="Bill type">{[['draft','Draft Bills'],['issued','Issued Bills'],['credit','Credit Notes']].map(([key,label])=><Link key={key} href={`/billing?kind=${key}`} aria-current={kind===key?'page':undefined}>{label}</Link>)}</nav>{!result.body?<p role="alert">Billing records could not be loaded. <Link href="/billing">Reset this view</Link>.</p>:result.body.items.length?<div className="workspace-table-wrap"><table className="table"><thead><tr><th>Reference</th><th>Matter</th><th>Date</th><th>Gross amount</th></tr></thead><tbody>{result.body.items.map(row=><tr key={row.id}><td><Link href={`/finance/${path}/${row.id}`}>{row.reference}{kind==='draft'?' · Draft':''}</Link></td><td>{row.matterReference}</td><td>{formatCalendarDate(row.date)}</td><td>{new Intl.NumberFormat('en-GB',{style:'currency',currency:'GBP'}).format(Number(row.grossPence)/100)}</td></tr>)}</tbody></table></div>:<WorkspaceEmpty title="No billing records in this view">Bills appear here after they are prepared through the matter&apos;s finance workspace.</WorkspaceEmpty>}{result.body?.next&&<p className="workspace-pagination"><Link href={`/billing?kind=${kind}&before=${result.body.next}`}>Older records →</Link></p>}<p className="workspace-guide-note">Amounts are invoice or credit totals. Payment allocations and unpaid balances are not shown in this register.</p><p><Link href="/finance">Rates, payments and reconciliations</Link></p></>;
}
