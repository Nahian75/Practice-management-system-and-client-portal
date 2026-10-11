import type { Metadata } from 'next';
import Link from 'next/link';
import { NoAccess } from '@/components/no-access';
import { apiGet } from '@/lib/api';
import type { ClientSummary } from '@/lib/clients';
import type { RegulatoryExport } from '@/lib/compliance';
import { formatDateTime } from '@/lib/format';
import { ExportForm } from './export-form';

export const metadata: Metadata = { title: 'Regulatory exports' };

export default async function ExportsPage() {
  const [exports, clients] = await Promise.all([
    apiGet<{ exports: RegulatoryExport[] }>('/compliance/exports'),
    apiGet<{ clients: ClientSummary[] }>('/compliance/clients'),
  ]);
  if (exports.status === 403) return <NoAccess what="AML regulatory exports" />;
  if (!exports.body) throw new Error('Could not load regulatory exports');
  const names = new Map((clients.body?.clients ?? []).map((client) => [client.id, `${client.reference}: ${client.name}`]));
  return <>
    <p><Link href="/compliance">Back to Compliance</Link></p><h1>Regulatory exports</h1>
    <p>Generate a fixed, encrypted ordinary AML bundle for a documented regulatory purpose. Suspicion reports and SAR/DAML records are never included here.</p>
    <ExportForm clients={clients.body?.clients ?? []} />
    <hr className="rule" /><h2>Generated exports</h2>
    {!exports.body.exports.length ? <p>No ordinary AML exports.</p> : <table className="table"><thead><tr><th scope="col">Client</th><th scope="col">Generated</th><th scope="col">Size</th><th scope="col">SHA-256</th><th scope="col">Download</th></tr></thead>
      <tbody>{exports.body.exports.map((item) => <tr key={item.id}><td>{names.get(item.clientId) ?? item.clientId}</td><td>{formatDateTime(item.createdAt)}</td>
        <td>{formatBytes(item.byteSize)}</td><td><code>{item.sha256}</code></td><td><a href={`/api/compliance/exports/${item.id}/content`}>Download fixed JSON</a></td></tr>)}</tbody></table>}
  </>;
}

function formatBytes(bytes: number) { return bytes < 1024 ? `${bytes} bytes` : `${(bytes / 1024).toFixed(1)} KB`; }
