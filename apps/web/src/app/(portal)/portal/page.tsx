import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { HowTo } from '@/components/how-to';
import { apiGet } from '@/lib/api';
import { formatDate } from '@/lib/format';
import { MATTER_STATUS_LABELS, MATTER_TYPE_LABELS, TEAM_ROLE_LABELS } from '@/lib/matters';
import type { EngagementDocument, PortalEvidenceRequest, PortalMatter, PortalPaymentRequest } from '@/lib/portal';
import { EvidenceRequests } from './evidence-requests';
import { PortalEngagementDocuments } from './portal-engagement-documents';
import { PortalPaymentRequests } from './portal-payment-requests';

export const metadata: Metadata = { title: 'Your matters' };

export default async function PortalMattersPage({ searchParams }: { searchParams: Promise<{ before?: string | string[] }> }) {
  const { before } = await searchParams;
  const [mattersResult, evidenceResult, engagementResult, paymentResult] = await Promise.all([
    apiGet<{ matters: PortalMatter[]; next: string | null }>('/portal/matters', {
      before: typeof before === 'string' ? before : undefined,
    }),
    apiGet<{ requests: PortalEvidenceRequest[] }>('/portal/evidence-requests'),
    apiGet<{ documents: EngagementDocument[] }>('/portal/engagement-documents'),
    apiGet<{ requests: PortalPaymentRequest[] }>('/portal/payment-requests'),
  ]);
  if (mattersResult.status === 401 || evidenceResult.status === 401 || engagementResult.status === 401 || paymentResult.status === 401) {
    redirect('/sign-in');
  }
  if (mattersResult.status === 403 || evidenceResult.status === 403 || engagementResult.status === 403 || paymentResult.status === 403) {
    redirect('/');
  }
  if (mattersResult.status === 400) {
    redirect('/portal');
  }
  if (!mattersResult.body) {
    throw new Error('The client matter list could not be loaded');
  }

  const requests = evidenceResult.body?.requests ?? [];
  const engagementDocs = engagementResult.body?.documents ?? [];
  const paymentRequests = paymentResult.body?.requests ?? [];

  return (
    <>
      <HowTo>
        <li>Anything the firm needs from you, such as a payment, a signature or evidence, appears at the top.</li>
        <li>Select a matter&rsquo;s title to see who is working on it and the documents shared with you.</li>
        <li>Select a document to download it.</li>
        <li>If something is unclear, contact a person named in the matter&rsquo;s team.</li>
      </HowTo>
      <PortalPaymentRequests requests={paymentRequests} />
      <PortalEngagementDocuments documents={engagementDocs} />
      <EvidenceRequests requests={requests} />
      <hr className="rule" />
      <h1>Your matters</h1>
      <p>Open and closed matters the firm has made available to you.</p>
      {mattersResult.body.matters.length === 0 ? (
        <p>You have no matters to view.</p>
      ) : (
        <table className="table">
          <caption className="secondary">Newest first.</caption>
          <thead>
            <tr>
              <th scope="col">Reference</th>
              <th scope="col">Title</th>
              <th scope="col">Type</th>
              <th scope="col">Status</th>
              <th scope="col">Opened</th>
              <th scope="col">Your legal team</th>
            </tr>
          </thead>
          <tbody>
            {mattersResult.body.matters.map((matter) => (
              <tr key={matter.id}>
                <td>{matter.reference}</td>
                <td>
                  <Link href={`/portal/matters/${matter.id}`}>{matter.title}</Link>
                </td>
                <td>{MATTER_TYPE_LABELS[matter.matterType]}</td>
                <td>{MATTER_STATUS_LABELS[matter.status]}</td>
                <td>{formatDate(matter.openedAt)}</td>
                <td>
                  {matter.team.map((member, index) => (
                    <span key={`${member.role}-${index}`}>
                      {index > 0 && <br />}
                      {member.displayName} <span className="secondary">({TEAM_ROLE_LABELS[member.role].toLowerCase()})</span>
                    </span>
                  ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {mattersResult.body.next && (
        <p>
          <Link href={`/portal?before=${encodeURIComponent(mattersResult.body.next)}`}>Older matters</Link>
        </p>
      )}
    </>
  );
}
