import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { NoAccess } from '@/components/no-access';
import { apiGet, currentAccount } from '@/lib/api';
import type { AiConfiguration, AiSupervisoryMetrics, AiAuditEvent } from '@/lib/ai';
import { AiGovernanceClient } from './ai-governance-client';

export const metadata: Metadata = { title: 'AI Governance & Supervisory Audit' };

export default async function AiGovernancePage() {
  const account = await currentAccount();
  if (!account) {
    notFound();
  }

  const [configRes, metricsRes, auditRes] = await Promise.all([
    apiGet<AiConfiguration>('/ai/config'),
    apiGet<AiSupervisoryMetrics>('/ai/metrics'),
    apiGet<{ events: AiAuditEvent[] }>('/ai/audit', { limit: '100' }),
  ]);

  if (configRes.status === 403 || metricsRes.status === 403 || auditRes.status === 403) {
    return <NoAccess what="AI Governance and supervisory audit metrics" />;
  }

  if (!configRes.body || !metricsRes.body || !auditRes.body) {
    return (
      <>
        <h1>AI Governance & Supervisory Audit</h1>
        <p className="secondary">Unable to load firm AI governance telemetry. Please try again later.</p>
      </>
    );
  }

  return (
    <>
      <span className="caption">Compliance & Supervision · SRA Code Paras 1.4 & 2.1</span>
      <h1>AI Governance & Supervisory Audit</h1>
      <p className="secondary">
        Firm-wide management of AI assistant model providers, token budgeting ceilings, prompt injection security, and human-in-the-loop review metrics.
      </p>

      <nav aria-label="AI Governance navigation" className="section-nav" style={{ marginBottom: '1.5rem' }}>
        <ul>
          <li>
            <Link href="/compliance">← Back to Compliance</Link>
          </li>
          <li>
            <Link href="/policies">Firm AI Usage Policy</Link>
          </li>
        </ul>
      </nav>

      <AiGovernanceClient
        initialConfig={configRes.body}
        metrics={metricsRes.body}
        events={auditRes.body.events}
      />
    </>
  );
}
