'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { AiConfiguration, AiSupervisoryMetrics, AiAuditEvent } from '@/lib/ai';
import { putJson, messagesOf } from '@/lib/requests';

interface AiGovernanceClientProps {
  initialConfig: AiConfiguration;
  metrics: AiSupervisoryMetrics;
  events: AiAuditEvent[];
}

export function AiGovernanceClient({ initialConfig, metrics, events }: AiGovernanceClientProps) {
  const router = useRouter();

  // Config state
  const [provider, setProvider] = useState(initialConfig.provider);
  const [modelName, setModelName] = useState(initialConfig.modelName);
  const [endpointUrl, setEndpointUrl] = useState(initialConfig.endpointUrl || '');
  const [maxTokens, setMaxTokens] = useState(initialConfig.maxTokensPerRequest);
  const [monthlyBudget, setMonthlyBudget] = useState(initialConfig.monthlyTokenBudget);
  const [enabled, setEnabled] = useState(initialConfig.enabled);

  const [isSaving, setIsSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [saveErrors, setSaveErrors] = useState<string[] | undefined>();

  const handleSaveConfig = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSaving(true);
    setSaveSuccess(false);
    setSaveErrors(undefined);

    try {
      const res = await putJson('/api/ai/config', {
        provider,
        modelName,
        endpointUrl: endpointUrl || null,
        maxTokensPerRequest: Number(maxTokens),
        monthlyTokenBudget: Number(monthlyBudget),
        enabled,
      });

      if (!res.ok) {
        setSaveErrors(await messagesOf(res));
        return;
      }

      setSaveSuccess(true);
      router.refresh();
    } catch {
      setSaveErrors(['Failed to update AI configuration. Please try again.']);
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '2rem' }}>
      {/* Metrics Overview Cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '1rem' }}>
        <div className="card" style={{ padding: '1.25rem', border: '1px solid #e2e8f0', borderRadius: '8px', background: '#ffffff' }}>
          <span className="secondary" style={{ fontSize: '0.85rem' }}>Firm Monthly Token Usage</span>
          <div style={{ fontSize: '1.75rem', fontWeight: 700, margin: '0.25rem 0 0.5rem', color: '#0f172a' }}>
            {metrics.monthlyBudget.tokensUsedThisMonth.toLocaleString()}{' '}
            <span style={{ fontSize: '1rem', fontWeight: 400, color: '#64748b' }}>
              / {metrics.monthlyBudget.monthlyTokenBudget.toLocaleString()}
            </span>
          </div>
          <div style={{ width: '100%', height: '8px', background: '#e2e8f0', borderRadius: '4px', overflow: 'hidden' }}>
            <div
              style={{
                width: `${Math.min(100, metrics.monthlyBudget.percentUsed)}%`,
                height: '100%',
                background: metrics.monthlyBudget.percentUsed > 80 ? '#ef4444' : '#0284c7',
              }}
            />
          </div>
          <span className="secondary" style={{ fontSize: '0.75rem', marginTop: '0.5rem', display: 'block' }}>
            Resets on {metrics.monthlyBudget.budgetResetOn} ({metrics.monthlyBudget.percentUsed}% used)
          </span>
        </div>

        <div className="card" style={{ padding: '1.25rem', border: '1px solid #e2e8f0', borderRadius: '8px', background: '#ffffff' }}>
          <span className="secondary" style={{ fontSize: '0.85rem' }}>Total Invocations</span>
          <div style={{ fontSize: '1.75rem', fontWeight: 700, margin: '0.25rem 0', color: '#0f172a' }}>
            {metrics.totalRequestsCount}
          </div>
          <span className="secondary" style={{ fontSize: '0.8rem' }}>
            Summaries: {metrics.requestsByFeature['summarise_document'] || 0} | Chronologies:{' '}
            {metrics.requestsByFeature['extract_chronology'] || 0}
          </span>
        </div>

        <div className="card" style={{ padding: '1.25rem', border: '1px solid #e2e8f0', borderRadius: '8px', background: '#ffffff' }}>
          <span className="secondary" style={{ fontSize: '0.85rem' }}>Human Review Ratio</span>
          <div style={{ display: 'flex', gap: '0.75rem', marginTop: '0.5rem' }}>
            <span style={{ color: '#16a34a', fontWeight: 600 }}>Accepted: {metrics.reviewDecisions.accepted}</span>
            <span style={{ color: '#0284c7', fontWeight: 600 }}>Modified: {metrics.reviewDecisions.modified}</span>
            <span style={{ color: '#dc2626', fontWeight: 600 }}>Rejected: {metrics.reviewDecisions.rejected}</span>
          </div>
          <span className="secondary" style={{ fontSize: '0.8rem', marginTop: '0.5rem', display: 'block' }}>
            Pending review: {metrics.reviewDecisions.pending}
          </span>
        </div>

        <div className="card" style={{ padding: '1.25rem', border: '1px solid #e2e8f0', borderRadius: '8px', background: '#ffffff' }}>
          <span className="secondary" style={{ fontSize: '0.85rem' }}>Security & SRA Compliance</span>
          <div style={{ margin: '0.5rem 0' }}>
            <div style={{ fontSize: '0.9rem', color: '#0f172a' }}>
              Prompt Injections Blocked:{' '}
              <strong style={{ color: metrics.securityAndCompliance.injectionsDetectedCount > 0 ? '#ef4444' : '#16a34a' }}>
                {metrics.securityAndCompliance.injectionsDetectedCount}
              </strong>
            </div>
            <div style={{ fontSize: '0.9rem', color: '#0f172a', marginTop: '0.25rem' }}>
              Hallucinated Citations Flagged:{' '}
              <strong>{metrics.securityAndCompliance.unverifiedCitationsCount}</strong>
            </div>
          </div>
          <span className="secondary" style={{ fontSize: '0.75rem' }}>Zero data retention policy active</span>
        </div>
      </div>

      {/* Configuration Form */}
      <section aria-labelledby="ai-config-heading" className="card" style={{ padding: '1.5rem', border: '1px solid #cbd5e1', borderRadius: '8px', background: '#ffffff' }}>
        <h2 id="ai-config-heading" style={{ marginTop: 0, fontSize: '1.25rem' }}>Firm AI Model & Governance Policy</h2>
        <p className="secondary" style={{ fontSize: '0.9rem', marginTop: '0.25rem' }}>
          Supervising partners control model endpoints, token allowances, and the firm-wide operational kill switch.
        </p>

        {saveSuccess && (
          <div className="notice" role="status" style={{ background: '#f0fdf4', borderLeft: '4px solid #16a34a', padding: '0.75rem', marginBottom: '1rem' }}>
            <p style={{ margin: 0, color: '#166534', fontWeight: 600 }}>AI configuration updated successfully.</p>
          </div>
        )}

        {saveErrors && (
          <div className="notice notice-error" role="alert" style={{ marginBottom: '1rem' }}>
            {saveErrors.map((err, i) => (
              <p key={i}>{err}</p>
            ))}
          </div>
        )}

        <form onSubmit={handleSaveConfig} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
            <div>
              <label htmlFor="ai-provider" style={{ display: 'block', fontWeight: 600, marginBottom: '0.25rem' }}>
                AI Provider Architecture
              </label>
              <select
                id="ai-provider"
                className="input"
                value={provider}
                onChange={(e) => setProvider(e.target.value)}
                style={{ width: '100%' }}
              >
                <option value="offline_mock">Offline Mock Legal Assistant (Zero Network / Sandbox)</option>
                <option value="azure_openai">Azure OpenAI UK South (Zero Data Retention)</option>
                <option value="aws_bedrock">AWS Bedrock London (Private Subnet)</option>
                <option value="custom">Custom On-Premise Llama.cpp / Ollama</option>
              </select>
            </div>

            <div>
              <label htmlFor="ai-model-name" style={{ display: 'block', fontWeight: 600, marginBottom: '0.25rem' }}>
                Model Identifier
              </label>
              <input
                id="ai-model-name"
                type="text"
                className="input"
                value={modelName}
                onChange={(e) => setModelName(e.target.value)}
                required
                style={{ width: '100%' }}
              />
            </div>
          </div>

          <div>
            <label htmlFor="ai-endpoint-url" style={{ display: 'block', fontWeight: 600, marginBottom: '0.25rem' }}>
              Custom Endpoint URL (Optional)
            </label>
            <input
              id="ai-endpoint-url"
              type="url"
              className="input"
              value={endpointUrl}
              onChange={(e) => setEndpointUrl(e.target.value)}
              placeholder="https://your-tenant.openai.azure.com"
              style={{ width: '100%' }}
            />
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
            <div>
              <label htmlFor="ai-max-tokens" style={{ display: 'block', fontWeight: 600, marginBottom: '0.25rem' }}>
                Max Tokens Per Request (Hard Ceiling)
              </label>
              <input
                id="ai-max-tokens"
                type="number"
                className="input"
                min={100}
                max={32768}
                value={maxTokens}
                onChange={(e) => setMaxTokens(Number(e.target.value))}
                required
                style={{ width: '100%' }}
              />
            </div>

            <div>
              <label htmlFor="ai-monthly-budget" style={{ display: 'block', fontWeight: 600, marginBottom: '0.25rem' }}>
                Firm Monthly Token Budget
              </label>
              <input
                id="ai-monthly-budget"
                type="number"
                className="input"
                min={1000}
                value={monthlyBudget}
                onChange={(e) => setMonthlyBudget(Number(e.target.value))}
                required
                style={{ width: '100%' }}
              />
            </div>
          </div>

          <div style={{ background: '#f8fafc', padding: '0.75rem 1rem', borderRadius: '6px', border: '1px solid #e2e8f0' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontWeight: 600, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={enabled}
                onChange={(e) => setEnabled(e.target.checked)}
              />
              <span>Enable AI Drafting Assistant across Firm</span>
            </label>
            <p className="secondary" style={{ margin: '0.25rem 0 0 1.5rem', fontSize: '0.8rem' }}>
              When unchecked, all AI generation requests are rejected immediately across all matters.
            </p>
          </div>

          <div>
            <button type="submit" className="button" disabled={isSaving}>
              {isSaving ? 'Saving Configuration...' : 'Save AI Governance Policy'}
            </button>
          </div>
        </form>
      </section>

      {/* Audit Log Table */}
      <section aria-labelledby="ai-audit-heading">
        <h2 id="ai-audit-heading">AI Invocation Supervisory Audit Log</h2>
        <p className="secondary" style={{ fontSize: '0.9rem' }}>
          Immutable log of all AI requests pursuant to SRA Code of Conduct Paragraph 2.1 supervision standards.
        </p>

        {events.length === 0 ? (
          <p className="secondary">No AI audit events recorded.</p>
        ) : (
          <table className="table" style={{ width: '100%' }}>
            <thead>
              <tr>
                <th scope="col">Timestamp</th>
                <th scope="col">Fee Earner</th>
                <th scope="col">Matter</th>
                <th scope="col">Feature</th>
                <th scope="col">Model</th>
                <th scope="col">Tokens</th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              {events.map((ev) => (
                <tr key={ev.id}>
                  <td>{new Date(ev.createdAt).toLocaleString('en-GB')}</td>
                  <td>{ev.actorName}</td>
                  <td>{ev.matterTitle}</td>
                  <td>{ev.feature.replace('_', ' ')}</td>
                  <td>{ev.modelName}</td>
                  <td>{ev.promptTokens + ev.completionTokens}</td>
                  <td>
                    <span
                      style={{
                        padding: '0.15rem 0.4rem',
                        borderRadius: '4px',
                        fontSize: '0.75rem',
                        fontWeight: 600,
                        background: ev.status === 'succeeded' ? '#dcfce7' : '#fee2e2',
                        color: ev.status === 'succeeded' ? '#166534' : '#991b1b',
                      }}
                    >
                      {ev.status}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
