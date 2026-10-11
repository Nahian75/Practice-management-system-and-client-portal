import type { Metadata } from 'next';
import { apiGet } from '@/lib/api';
import type { ClientSummary } from '@/lib/clients';
import { ReportConcernForm } from './report-concern-form';

export const metadata: Metadata = { title: 'Report a concern' };

export default async function ReportConcernPage() {
  const { body } = await apiGet<{ clients: ClientSummary[]; next: string | null }>('/clients');
  return <>
    <h1>Report a concern</h1>
    <p>Send facts privately for review by the firm&apos;s nominated officer. Use this when something you observed may need a confidential AML or terrorist-financing decision.</p>
    <div className="notice"><p><strong>Do not investigate or discuss the report with the client.</strong> If somebody is at immediate risk, follow the firm&apos;s emergency procedure as well.</p></div>
    <ReportConcernForm clients={body?.clients ?? []} />
  </>;
}
