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
    <div className={["ai-rule-67"].join(" ")}>
      {/* Metrics Overview Cards */}
      <div className={["ai-rule-68"].join(" ")}>
        <div  className={["card","ai-rule-69"].join(" ")}>
          <span  className={["secondary","ai-rule-70"].join(" ")}>Firm Monthly Token Usage</span>
          <div className={["ai-rule-71"].join(" ")}>
            {metrics.monthlyBudget.tokensUsedThisMonth.toLocaleString()}{' '}
            <span className={["ai-rule-72"].join(" ")}>
              / {metrics.monthlyBudget.monthlyTokenBudget.toLocaleString()}
            </span>
          </div>
          <div className={["ai-rule-73"].join(" ")}>
            <progress className={metrics.monthlyBudget.percentUsed > 80 ? 'ai-budget-progress ai-budget-high' : 'ai-budget-progress'} value={Math.max(0, Math.min(100, metrics.monthlyBudget.percentUsed))} max={100} aria-label="AI token budget used" />
          </div>
          <span  className={["secondary","ai-rule-74"].join(" ")}>
            Resets on {metrics.monthlyBudget.budgetResetOn} ({metrics.monthlyBudget.percentUsed}% used)
          </span>
        </div>

        <div  className={["card","ai-rule-69"].join(" ")}>
          <span  className={["secondary","ai-rule-70"].join(" ")}>Total Invocations</span>
          <div className={["ai-rule-75"].join(" ")}>
            {metrics.totalRequestsCount}
          </div>
          <span  className={["secondary","ai-rule-46"].join(" ")}>
            Summaries: {metrics.requestsByFeature['summarise_document'] || 0} | Chronologies:{' '}
            {metrics.requestsByFeature['extract_chronology'] || 0}
          </span>
        </div>

        <div  className={["card","ai-rule-69"].join(" ")}>
          <span  className={["secondary","ai-rule-70"].join(" ")}>Human Review Ratio</span>
          <div className={["ai-rule-76"].join(" ")}>
            <span className={["ai-rule-77"].join(" ")}>Accepted: {metrics.reviewDecisions.accepted}</span>
            <span className={["ai-rule-78"].join(" ")}>Modified: {metrics.reviewDecisions.modified}</span>
            <span className={["ai-rule-79"].join(" ")}>Rejected: {metrics.reviewDecisions.rejected}</span>
          </div>
          <span  className={["secondary","ai-rule-80"].join(" ")}>
            Pending review: {metrics.reviewDecisions.pending}
          </span>
        </div>

        <div  className={["card","ai-rule-69"].join(" ")}>
          <span  className={["secondary","ai-rule-70"].join(" ")}>Security & SRA Compliance</span>
          <div className={["ai-rule-81"].join(" ")}>
            <div className={["ai-rule-36"].join(" ")}>
              Prompt Injections Blocked:{' '}
              <strong className={[(metrics.securityAndCompliance.injectionsDetectedCount > 0 ? "ai-rule-82" : "ai-rule-83")].join(" ")}>
                {metrics.securityAndCompliance.injectionsDetectedCount}
              </strong>
            </div>
            <div className={["ai-rule-84"].join(" ")}>
              Hallucinated Citations Flagged:{' '}
              <strong>{metrics.securityAndCompliance.unverifiedCitationsCount}</strong>
            </div>
          </div>
          <span  className={["secondary","ai-rule-85"].join(" ")}>Zero data retention policy active</span>
        </div>
      </div>

      {/* Configuration Form */}
      <section aria-labelledby="ai-config-heading"  className={["card","ai-rule-86"].join(" ")}>
        <h2 id="ai-config-heading" className={["ai-rule-87"].join(" ")}>Firm AI Model & Governance Policy</h2>
        <p  className={["secondary","ai-rule-88"].join(" ")}>
          Supervising partners control model endpoints, token allowances, and the firm-wide operational kill switch.
        </p>

        {saveSuccess && (
          <div  role="status" className={["notice","ai-rule-89"].join(" ")}>
            <p className={["ai-rule-90"].join(" ")}>AI configuration updated successfully.</p>
          </div>
        )}

        {saveErrors && (
          <div  role="alert" className={["notice notice-error","ai-rule-91"].join(" ")}>
            {saveErrors.map((err, i) => (
              <p key={i}>{err}</p>
            ))}
          </div>
        )}

        <form onSubmit={handleSaveConfig} className={["ai-rule-18"].join(" ")}>
          <div className={["ai-rule-54"].join(" ")}>
            <div>
              <label htmlFor="ai-provider" className={["ai-rule-19"].join(" ")}>
                AI Provider Architecture
              </label>
              <select
                id="ai-provider"
                
                value={provider}
                onChange={(e) => setProvider(e.target.value)}
                className={["input","ai-rule-20"].join(" ")}
              >
                <option value="offline_mock">Offline Mock Legal Assistant (Zero Network / Sandbox)</option>
                <option value="azure_openai">Azure OpenAI UK South (Zero Data Retention)</option>
                <option value="aws_bedrock">AWS Bedrock London (Private Subnet)</option>
                <option value="custom">Custom On-Premise Llama.cpp / Ollama</option>
              </select>
            </div>

            <div>
              <label htmlFor="ai-model-name" className={["ai-rule-19"].join(" ")}>
                Model Identifier
              </label>
              <input
                id="ai-model-name"
                type="text"
                
                value={modelName}
                onChange={(e) => setModelName(e.target.value)}
                required
                className={["input","ai-rule-20"].join(" ")}
              />
            </div>
          </div>

          <div>
            <label htmlFor="ai-endpoint-url" className={["ai-rule-19"].join(" ")}>
              Custom Endpoint URL (Optional)
            </label>
            <input
              id="ai-endpoint-url"
              type="url"
              
              value={endpointUrl}
              onChange={(e) => setEndpointUrl(e.target.value)}
              placeholder="https://your-tenant.openai.azure.com"
              className={["input","ai-rule-20"].join(" ")}
            />
          </div>

          <div className={["ai-rule-54"].join(" ")}>
            <div>
              <label htmlFor="ai-max-tokens" className={["ai-rule-19"].join(" ")}>
                Max Tokens Per Request (Hard Ceiling)
              </label>
              <input
                id="ai-max-tokens"
                type="number"
                
                min={100}
                max={32768}
                value={maxTokens}
                onChange={(e) => setMaxTokens(Number(e.target.value))}
                required
                className={["input","ai-rule-20"].join(" ")}
              />
            </div>

            <div>
              <label htmlFor="ai-monthly-budget" className={["ai-rule-19"].join(" ")}>
                Firm Monthly Token Budget
              </label>
              <input
                id="ai-monthly-budget"
                type="number"
                
                min={1000}
                value={monthlyBudget}
                onChange={(e) => setMonthlyBudget(Number(e.target.value))}
                required
                className={["input","ai-rule-20"].join(" ")}
              />
            </div>
          </div>

          <div className={["ai-rule-92"].join(" ")}>
            <label className={["ai-rule-93"].join(" ")}>
              <input
                type="checkbox"
                checked={enabled}
                onChange={(e) => setEnabled(e.target.checked)}
              />
              <span>Enable AI Drafting Assistant across Firm</span>
            </label>
            <p  className={["secondary","ai-rule-94"].join(" ")}>
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
        <p  className={["secondary","ai-rule-28"].join(" ")}>
          Immutable log of all AI requests pursuant to SRA Code of Conduct Paragraph 2.1 supervision standards.
        </p>

        {events.length === 0 ? (
          <p className="secondary">No AI audit events recorded.</p>
        ) : (
          <table  className={["table","ai-rule-20"].join(" ")}>
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
                      className={["ai-rule-95",(ev.status === 'succeeded' ? "ai-rule-37" : "ai-rule-39"),(ev.status === 'succeeded' ? "ai-rule-41" : "ai-rule-43")].join(" ")}
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
