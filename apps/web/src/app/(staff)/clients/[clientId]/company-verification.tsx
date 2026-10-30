'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ErrorSummary } from '@/components/error-summary';
import type { CompanyDiscrepancy, CompanySnapshot } from '@/lib/onboarding';
import { formatDateTime } from '@/lib/format';
import { messagesOf, postJson } from '@/lib/requests';

interface LookupResult {
  available: boolean;
  snapshot?: {
    companyNumber: string;
    companyName: string;
    companyStatus: string;
    companyType: string | null;
    jurisdiction: string | null;
    incorporationDate: string | null;
    registeredOffice: Record<string, unknown>;
    officers: unknown[];
    rawPayloadJson: string;
  };
  discrepancies?: CompanyDiscrepancy[];
  error?: string;
}

export function CompanyVerification({
  clientId,
  defaultCompanyNumber,
  isConfigured,
  snapshots,
}: {
  clientId: string;
  defaultCompanyNumber: string | null;
  isConfigured: boolean;
  snapshots: CompanySnapshot[];
}) {
  const router = useRouter();
  const [companyNumber, setCompanyNumber] = useState(defaultCompanyNumber ?? '');
  const [lookup, setLookup] = useState<LookupResult | null>(null);
  const [lookingUp, setLookingUp] = useState(false);
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<string[]>();
  const [statusMsg, setStatusMsg] = useState<string>();

  async function handleLookup(e: React.FormEvent) {
    e.preventDefault();
    if (!companyNumber.trim()) return;
    setLookingUp(true);
    setErrors(undefined);
    setStatusMsg(undefined);
    try {
      const res = await fetch(`/api/clients/${clientId}/companies-house/lookup?companyNumber=${encodeURIComponent(companyNumber.trim())}`);
      const data = (await res.json()) as LookupResult;
      setLookup(data);
      if (data.error) {
        setErrors([data.error]);
      }
    } catch {
      setErrors(['Unable to reach Companies House lookup service']);
    } finally {
      setLookingUp(false);
    }
  }

  async function handleSaveSnapshot() {
    if (!lookup?.snapshot) return;
    setSaving(true);
    setErrors(undefined);
    try {
      const res = await postJson(`/api/clients/${clientId}/company-snapshots`, {
        source: 'companies_house',
        companyNumber: lookup.snapshot.companyNumber,
        companyName: lookup.snapshot.companyName,
        companyStatus: lookup.snapshot.companyStatus,
        companyType: lookup.snapshot.companyType ?? undefined,
        jurisdiction: lookup.snapshot.jurisdiction ?? undefined,
        incorporationDate: lookup.snapshot.incorporationDate ?? undefined,
        registeredOffice: lookup.snapshot.registeredOffice,
        officers: lookup.snapshot.officers,
        discrepancies: lookup.discrepancies ?? [],
        rawPayloadJson: lookup.snapshot.rawPayloadJson,
      });
      if (!res.ok) {
        setErrors(await messagesOf(res));
        return;
      }
      setStatusMsg('Company snapshot recorded successfully.');
      setLookup(null);
      router.refresh();
    } catch {
      setErrors(['Failed to save company snapshot']);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section aria-labelledby="company-verification-heading" className="region">
      <h2 id="company-verification-heading">Company verification</h2>

      {!isConfigured ? (
        <p className="notice">
          Companies House integration is not configured. External registry verification must be recorded via manual documentation.
        </p>
      ) : (
        <form aria-label="Look up company in register" onSubmit={handleLookup}>
          <div className="field">
            <label className="label" htmlFor="companyNumber">Companies House registration number</label>
            <div className="form-grid">
              <input
                className="input"
                id="companyNumber"
                name="companyNumber"
                value={companyNumber}
                onChange={(e) => setCompanyNumber(e.target.value)}
                placeholder="e.g. 01234567"
                required
                maxLength={50}
              />
              <button className="button button-secondary" type="submit" disabled={lookingUp}>
                {lookingUp ? 'Checking register...' : 'Look up company'}
              </button>
            </div>
          </div>
        </form>
      )}

      {errors && <ErrorSummary messages={errors} />}
      <div role="status">{statusMsg && <p className="notice">{statusMsg}</p>}</div>

      {lookup?.snapshot && (
        <div className="card mt-4" >
          <h3>Companies House result: {lookup.snapshot.companyName}</h3>
          <p>
            <strong>Number:</strong> {lookup.snapshot.companyNumber} ·{' '}
            <strong>Status:</strong> {lookup.snapshot.companyStatus} ·{' '}
            <strong>Type:</strong> {lookup.snapshot.companyType ?? 'N/A'} ·{' '}
            <strong>Jurisdiction:</strong> {lookup.snapshot.jurisdiction ?? 'N/A'}
          </p>

          {!!lookup.discrepancies?.length && (
            <div className="notice border-red-700" >
              <strong>Discrepancies against client record detected:</strong>
              <ul>
                {lookup.discrepancies.map((d, index) => (
                  <li key={index}>{d.description}</li>
                ))}
              </ul>
              <small>Discrepancies are highlighted for human review and never overwrite client details automatically.</small>
            </div>
          )}

          <div className="mt-4">
            <button className="button" type="button" onClick={handleSaveSnapshot} disabled={saving}>
              {saving ? 'Saving...' : 'Save company snapshot to record'}
            </button>
          </div>
        </div>
      )}

      {snapshots.length > 0 && (
        <div className="mt-6">
          <h3>Recorded company snapshots</h3>
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Company</th>
                <th scope="col">Number</th>
                <th scope="col">Status</th>
                <th scope="col">Discrepancies</th>
                <th scope="col">Retrieved</th>
              </tr>
            </thead>
            <tbody>
              {snapshots.map((s) => (
                <tr key={s.id}>
                  <td>{s.companyName}</td>
                  <td>{s.companyNumber}</td>
                  <td>{s.companyStatus}</td>
                  <td>
                    {s.discrepancies.length > 0 ? (
                      <span className="tag tag-danger">{s.discrepancies.length} discrepancy</span>
                    ) : (
                      'None'
                    )}
                  </td>
                  <td>{formatDateTime(s.retrievedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
