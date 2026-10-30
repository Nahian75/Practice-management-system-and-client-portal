'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { ErrorSummary } from '@/components/error-summary';
import type { ElectronicCheck } from '@/lib/onboarding';
import { formatCalendarDate, formatDateTime } from '@/lib/format';
import { messagesOf, postJson } from '@/lib/requests';

export function ElectronicChecks({
  clientId,
  checks,
}: {
  clientId: string;
  checks: ElectronicCheck[];
}) {
  const router = useRouter();
  const [openForm, setOpenForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<string[]>();
  const [statusMsg, setStatusMsg] = useState<string>();

  async function handleRecordCheck(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setSaving(true);
    setErrors(undefined);
    setStatusMsg(undefined);

    const rawResponse = JSON.stringify({
      provider: form.get('provider'),
      reference: form.get('providerReference'),
      result: form.get('result'),
      recorded_manual_entry: true,
      timestamp: new Date().toISOString(),
    });

    try {
      const res = await postJson(`/api/clients/${clientId}/electronic-checks`, {
        provider: String(form.get('provider') ?? '').trim(),
        service: String(form.get('service') ?? '').trim(),
        providerReference: String(form.get('providerReference') ?? '').trim(),
        documentType: String(form.get('documentType') ?? '').trim(),
        checkDate: String(form.get('checkDate') ?? '').trim(),
        result: form.get('result'),
        livenessResult: form.get('livenessResult') || null,
        evidenceMatch: String(form.get('evidenceMatch') ?? '').trim() || null,
        exceptionNote: String(form.get('exceptionNote') ?? '').trim() || null,
        rawResponseJson: rawResponse,
      });

      if (!res.ok) {
        setErrors(await messagesOf(res));
        return;
      }
      setStatusMsg('Electronic check recorded successfully.');
      setOpenForm(false);
      router.refresh();
    } catch {
      setErrors(['Failed to record electronic check']);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section aria-labelledby="electronic-checks-heading" className="region">
      <div className="flex justify-between items-center">
        <h2 id="electronic-checks-heading">Electronic verification checks</h2>
        <button
          className="button button-secondary"
          type="button"
          onClick={() => setOpenForm(!openForm)}
        >
          {openForm ? 'Cancel' : 'Record electronic check'}
        </button>
      </div>

      <div role="status">{statusMsg && <p className="notice">{statusMsg}</p>}</div>
      {errors && <ErrorSummary messages={errors} />}

      {openForm && (
        <form
          aria-label="Record electronic verification check"
          onSubmit={handleRecordCheck}
          className="card mt-4 mb-6"

        >
          <h3>Record electronic check result</h3>
          <div className="form-grid">
            <div className="field">
              <label className="label" htmlFor="provider">Provider</label>
              <input className="input" id="provider" name="provider" placeholder="e.g. LexisNexis, Onfido, Credas" required maxLength={100} />
            </div>
            <div className="field">
              <label className="label" htmlFor="service">Service</label>
              <input className="input" id="service" name="service" placeholder="e.g. Identity and PEP/Sanctions" required maxLength={100} />
            </div>
          </div>

          <div className="form-grid">
            <div className="field">
              <label className="label" htmlFor="providerReference">Provider reference</label>
              <input className="input" id="providerReference" name="providerReference" placeholder="e.g. REF-123456" required maxLength={150} />
            </div>
            <div className="field">
              <label className="label" htmlFor="documentType">Document type</label>
              <input className="input" id="documentType" name="documentType" placeholder="e.g. Passport, Driving Licence" required maxLength={100} />
            </div>
          </div>

          <div className="form-grid">
            <div className="field">
              <label className="label" htmlFor="checkDate">Check date</label>
              <input className="input input-date" id="checkDate" name="checkDate" type="date" required />
            </div>
            <div className="field">
              <label className="label" htmlFor="result">Overall result</label>
              <select className="select" id="result" name="result" required>
                <option value="pass">Pass</option>
                <option value="refer">Refer</option>
                <option value="fail">Fail</option>
              </select>
            </div>
            <div className="field">
              <label className="label" htmlFor="livenessResult">Liveness result</label>
              <select className="select" id="livenessResult" name="livenessResult">
                <option value="not_checked">Not checked</option>
                <option value="pass">Pass</option>
                <option value="refer">Refer</option>
                <option value="fail">Fail</option>
              </select>
            </div>
          </div>

          <div className="field">
            <label className="label" htmlFor="evidenceMatch">Evidence match notes</label>
            <input className="input" id="evidenceMatch" name="evidenceMatch" placeholder="e.g. Verified full name and date of birth match" maxLength={1000} />
          </div>

          <div className="field">
            <label className="label" htmlFor="exceptionNote">Exception or review note</label>
            <textarea className="input" id="exceptionNote" name="exceptionNote" rows={2} maxLength={2000} />
          </div>

          <button className="button" type="submit" disabled={saving}>
            {saving ? 'Recording...' : 'Save electronic check'}
          </button>
        </form>
      )}

      {checks.length === 0 ? (
        <p>No electronic verification checks recorded.</p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th scope="col">Provider & Service</th>
              <th scope="col">Reference</th>
              <th scope="col">Document</th>
              <th scope="col">Date</th>
              <th scope="col">Result</th>
              <th scope="col">Liveness</th>
              <th scope="col">Recorded</th>
            </tr>
          </thead>
          <tbody>
            {checks.map((chk) => (
              <tr key={chk.id}>
                <td>{chk.provider} ({chk.service})</td>
                <td>{chk.providerReference}</td>
                <td>{chk.documentType}</td>
                <td>{formatCalendarDate(chk.checkDate)}</td>
                <td>
                  <span className={`tag ${chk.result === 'pass' ? 'tag-success' : chk.result === 'fail' ? 'tag-danger' : 'tag-warning'}`}>
                    {chk.result.toUpperCase()}
                  </span>
                </td>
                <td>{chk.livenessResult ? chk.livenessResult.replace('_', ' ') : '—'}</td>
                <td>{formatDateTime(chk.recordedAt)} by {chk.recordedBy.displayName}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
