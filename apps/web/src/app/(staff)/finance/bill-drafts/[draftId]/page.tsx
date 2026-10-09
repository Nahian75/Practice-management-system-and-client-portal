import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { NoAccess } from '@/components/no-access';
import { apiGet } from '@/lib/api';
import { pounds, type BillDraft, type FinanceAccess } from '@/lib/finance';
import { BillDraftForm, IssueBillButton } from '../../bill-draft-form';

export const metadata: Metadata = { title: 'Draft bill' };
export default async function DraftBillPage({ params }: { params: Promise<{ draftId: string }> }) {
  const { draftId } = await params; const [draft, access] = await Promise.all([apiGet<BillDraft>(`/bill-drafts/${encodeURIComponent(draftId)}`), apiGet<FinanceAccess>('/finance/access')]);
  if (draft.status === 403 || !access.body?.canManageBilling) return <NoAccess what="draft billing" />; if (!draft.body) notFound();
  return <><span className="caption">Draft • not yet posted</span><h1>Draft bill for matter</h1><div className="actions"><Link href="/finance">Back to Finance</Link><Link href={`/finance/matters/${draft.body.matterId}`}>Matter finance</Link></div>
    <p className="notice"><strong>Review before issue.</strong> Issuing fixes the client, supplier, line, VAT and total snapshots permanently.</p><dl className="summary"><div className="summary-row"><dt>Current total</dt><dd>{pounds(draft.body.gross)}</dd></div><div className="summary-row"><dt>Lines</dt><dd>{draft.body.lines.length}</dd></div></dl>
    <BillDraftForm matterId={draft.body.matterId} draft={draft.body} /><div className="after-form"><IssueBillButton draftId={draft.body.id} /></div>
  </>;
}
