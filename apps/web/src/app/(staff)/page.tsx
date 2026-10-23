import type { Metadata } from 'next';
import Link from 'next/link';
import { apiGet, currentAccount } from '@/lib/api';
import type { ClientSummary } from '@/lib/clients';
import { MATTER_STATUS_LABELS, MATTER_TYPE_LABELS, type MatterSummary } from '@/lib/matters';
import type { NotificationPage } from '@/lib/notifications';
import type { ComplianceAccess } from '@/lib/compliance';
import { StatusTag, type TagVariant } from '@/components/status-tag';

export const metadata: Metadata = { title: 'Home' };

function statusToVariant(status: MatterSummary['status']): TagVariant {
  switch (status) {
    case 'open':
      return 'green';
    case 'awaiting_clearance':
      return 'yellow';
    case 'closed':
      return 'grey';
  }
}

export default async function HomePage() {
  const [account, clientsRes, mattersRes, notificationsRes, complianceRes, financeRes] = await Promise.all([
    currentAccount(),
    apiGet<{ clients: ClientSummary[]; next: string | null }>('/clients'),
    apiGet<{ matters: MatterSummary[]; next: string | null }>('/matters'),
    apiGet<NotificationPage>('/notifications'),
    apiGet<ComplianceAccess>('/compliance/access'),
    apiGet('/finance/access'),
  ]);

  const clients = clientsRes.body?.clients ?? [];
  const matters = mattersRes.body?.matters ?? [];
  const unreadCount = notificationsRes.body?.unreadCount ?? 0;
  const complianceAttention = complianceRes.body?.attentionCount ?? 0;
  const canViewFinance = financeRes.status === 200;
  const matterCount = `${matters.length}${mattersRes.body?.next ? '+' : ''}`;
  const clientCount = `${clients.length}${clientsRes.body?.next ? '+' : ''}`;

  return (
    <>
      <div className="dashboard-heading">
        <div>
          <span className="caption">Practice overview &middot; England &amp; Wales</span>
          <h1>Good day, {account?.displayName}</h1>
          <p className="secondary">Your operational overview and priority work.</p>
        </div>
        <div className="dashboard-assurance" aria-label="Workspace access">
          <StatusTag variant="blue">England &amp; Wales</StatusTag>
          <StatusTag variant="green">Role-based access</StatusTag>
          <StatusTag variant="purple">Matter-based access</StatusTag>
        </div>
      </div>

      {/* Key Practice Performance Metrics */}
      <div className="metric-grid">
        {mattersRes.status === 200 && (
          <div className="metric-card metric-card-accent">
            <span className="metric-label">Matter teams</span>
            <span className="metric-value">{matterCount}</span>
            <span className="metric-sub">Visible records, including closed matters</span>
          </div>
        )}

        {clientsRes.status === 200 && (
          <div className="metric-card">
            <span className="metric-label">Visible clients</span>
            <span className="metric-value">{clientCount}</span>
            <span className="metric-sub">Clients you manage or whose matter team you are on</span>
          </div>
        )}

        {complianceRes.status === 200 && (
          <div className={`metric-card ${complianceAttention > 0 ? 'metric-card-warning' : 'metric-card-success'}`}>
            <span className="metric-label">Compliance actions</span>
            <span className="metric-value">{complianceAttention}</span>
            <span className="metric-sub">
              {complianceAttention > 0 ? 'Items requiring attention' : 'No ordinary actions require attention'}
            </span>
          </div>
        )}

        <div className={`metric-card ${unreadCount > 0 ? 'metric-card-accent' : ''}`}>
          <span className="metric-label">Unread notices</span>
          <span className="metric-value">{unreadCount}</span>
          <span className="metric-sub">Task assignments &amp; alerts</span>
        </div>
      </div>

      {/* Common Practice Actions */}
      <h2>Common practice actions</h2>
      <div className="quick-action-grid">
        {clientsRes.status === 200 && (
          <Link className="quick-action-card" href="/clients/new">
            <strong>New Client &amp; Conflict Check</strong>
            <p>Register an individual or company client and complete the practice&rsquo;s conflict check.</p>
          </Link>
        )}

        {mattersRes.status === 200 && (
          <Link className="quick-action-card" href="/matters">
            <strong>Matters Workspace</strong>
            <p>Review active instructions, file documents, and track team progress.</p>
          </Link>
        )}

        {complianceRes.status === 200 && (
          <Link className="quick-action-card" href="/compliance">
            <strong>Compliance &amp; AML Oversight</strong>
            <p>Review AML risk ratings, sanctions screening, and compliance work.</p>
          </Link>
        )}

        {canViewFinance && (
          <Link className="quick-action-card" href="/finance">
            <strong>Finance Workspace</strong>
            <p>Review client and office bank balances, disbursements, and unallocated receipts.</p>
          </Link>
        )}
      </div>

      <hr className="rule" />

      {/* Recent matters summary */}
      {mattersRes.status === 200 && (
        <>
          <h2>Recent matters</h2>
          {matters.length === 0 ? (
            <div className="inset-text">
              <p>You are on no matter team yet.</p>
              <p className="secondary" style={{ marginBottom: 0 }}>
                To open an instruction, navigate to a client record or register a new client.
              </p>
            </div>
          ) : (
            <table className="table">
              <caption className="secondary">
                Showing up to 5 most recent matters assigned to your teams.
              </caption>
              <thead>
                <tr>
                  <th scope="col">Reference</th>
                  <th scope="col">Title</th>
                  <th scope="col">Client</th>
                  <th scope="col">Type</th>
                  <th scope="col">Status</th>
                </tr>
              </thead>
              <tbody>
                {matters.slice(0, 5).map((matter) => (
                  <tr key={matter.id}>
                    <td>
                      <strong>{matter.reference}</strong>
                    </td>
                    <td>
                      <Link href={`/matters/${matter.id}`}>{matter.title}</Link>
                    </td>
                    <td>{matter.client.name}</td>
                    <td>{MATTER_TYPE_LABELS[matter.matterType]}</td>
                    <td>
                      <StatusTag variant={statusToVariant(matter.status)}>
                        {MATTER_STATUS_LABELS[matter.status]}
                      </StatusTag>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </>
  );
}
