import Link from 'next/link';
import {apiGet} from '@/lib/api';
import type {BankAccount} from '@/lib/finance';
import {WorkspaceHeading} from '@/components/workspace-page';
import {NoAccess} from '@/components/no-access';
export const metadata={title:'Accounts'};
export default async function Page(){const result=await apiGet<{bankAccounts:BankAccount[]}>('/finance/bank-accounts');if(result.status===403)return <NoAccess what="bank accounts"/>;return <><WorkspaceHeading title="Accounts" description="Review the client and business bank accounts recorded for your practice."/><div className="workspace-card">{!result.body?<p role="alert">Accounts could not be loaded.</p>:!result.body.bankAccounts.length?<p>No bank accounts recorded. <Link href="/finance">Open Finance</Link> to add one.</p>:<ul className="workspace-link-list">{result.body.bankAccounts.map(bank=><li key={bank.id}><Link href={`/finance/bank-accounts/${bank.id}`}>{bank.name}<span>{bank.kind==='client'?'Client account':'Business account'} · ending {bank.lastFour}</span></Link></li>)}</ul>}<p><Link href="/finance">Bank statements and reconciliation</Link></p></div></>;}
