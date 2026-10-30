'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { ErrorSummary } from '@/components/error-summary';
import type { ActivationException, ActivationGate } from '@/lib/onboarding';
import { formatDate } from '@/lib/format';
import { messagesOf, postJson } from '@/lib/requests';

const REQ_KEY_LABELS: Record<string, string> = {
  conflict_check: 'Conflict search and resolution',
  email_verification: 'Email contact verification',
  id_verification: 'Identity and company evidence',
  cdd_compliance: 'CDD and compliance clearance',
};

const STATUS_BADGES: Record<string, { label: string; className: string }> = {
  satisfied: { label: 'Satisfied', className: 'badge badge-success' },
  exception: { label: 'Exception granted', className: 'badge badge-info' },
  pending: { label: 'Pending', className: 'badge badge-warning' },
  blocked: { label: 'Blocked', className: 'badge badge-danger' },
};

const OVERALL_BADGES: Record<string, { label: string; className: string }> = {
  activated: { label: 'Activated', className: 'badge badge-success' },
  ready: { label: 'Ready for activation', className: 'badge badge-success' },
  pending: { label: 'Pending requirements', className: 'badge badge-warning' },
  blocked: { label: 'Blocked', className: 'badge badge-danger' },
};

export function ActivationGatePanel({
  clientId,
  gate,
  exceptions,
}: {
  clientId: string;
  gate: ActivationGate;
  exceptions: ActivationException[];
}) {
  const router = useRouter();
  const [openExceptionForm, setOpenExceptionForm] = useState(false);
  const [openActivateForm, setOpenActivateForm] = useState(false);

  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<string[]>();
  const [statusMsg, setStatusMsg] = useState<string>();

  async function handleGrantException(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setSaving(true);
    setErrors(undefined);
    setStatusMsg(undefined);

    const days = Number(form.get('durationDays') ?? 14);
    const expiresAt = new Date(Date.now() + days * 86400000).toISOString();

    try {
      const res = await postJson(`/api/clients/${clientId}/activation-exceptions`, {
        requirementKey: form.get('requirementKey'),
        reason: String(form.get('reason') ?? '').trim(),
        expiresAt,
      });

      if (!res.ok) {
        setErrors(await messagesOf(res));
        return;
      }

      setStatusMsg('Onboarding exception granted successfully.');
      setOpenExceptionForm(false);
      router.refresh();
    } catch {
      setErrors(['Failed to grant onboarding exception']);
    } finally {
      setSaving(false);
    }
  }

  async function handleActivateClient(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setSaving(true);
    setErrors(undefined);
    setStatusMsg(undefined);

    try {
      const res = await postJson(`/api/clients/${clientId}/activate`, {
        notes: String(form.get('notes') ?? '').trim() || null,
      });

      if (!res.ok) {
        setErrors(await messagesOf(res));
        return;
      }

      setStatusMsg('Client onboarding formally activated.');
      setOpenActivateForm(false);
      router.refresh();
    } catch {
      setErrors(['Failed to activate client']);
    } finally {
      setSaving(false);
    }
  }

  const overallBadge = OVERALL_BADGES[gate.status] ?? { label: gate.status, className: 'badge' };

  return (
    <section aria-labelledby="gate-heading" className="panel mt-8" >
      <div className="flex justify-between items-center">
        <div>
          <h2 id="gate-heading" className="m-0">Onboarding activation gate</h2>
          <p className="secondary mt-2 mx-0 mb-0" >
            Enforces conflict search, email channel verification, identity/company evidence, and CDD clearance.
          </p>
        </div>
        <div>
          <span className={[overallBadge.className,"text-base py-2 px-4"].filter(Boolean).join(" ")} >
            {overallBadge.label}
          </span>
        </div>
      </div>

      {statusMsg && <p className="status status-success mt-4" role="status" >{statusMsg}</p>}
      {errors && <ErrorSummary messages={errors} />}

      {gate.isActivated && (
        <div className="card mt-4 bg-slate-100" >
          <p className="m-0">
            <strong>Client activated:</strong> Activated on {gate.activatedAt ? formatDate(gate.activatedAt) : 'recorded date'}.
            {gate.notes && <span> Notes: {gate.notes}</span>}
          </p>
        </div>
      )}

      {/* Mandatory Requirements Checklist */}
      <div className="mt-6">
        <h3>Mandatory requirements</h3>
        <table className="table mt-2" >
          <thead>
            <tr>
              <th scope="col">Requirement</th>
              <th scope="col">Status</th>
              <th scope="col">Details</th>
              <th scope="col">Last activity</th>
            </tr>
          </thead>
          <tbody>
            {gate.requirements.map((req) => {
              const badge = STATUS_BADGES[req.status] ?? { label: req.status, className: 'badge' };
              return (
                <tr key={req.key}>
                  <td><strong>{req.title}</strong></td>
                  <td><span className={badge.className}>{badge.label}</span></td>
                  <td>
                    {req.details}
                    {req.reviewer && <span className="secondary"> (Reviewer: {req.reviewer})</span>}
                  </td>
                  <td>{req.lastEventAt ? formatDate(req.lastEventAt) : '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Active Exceptions */}
      {exceptions.length > 0 && (
        <div className="mt-6">
          <h3>Granted onboarding exceptions</h3>
          <table className="table mt-2" >
            <thead>
              <tr>
                <th scope="col">Requirement</th>
                <th scope="col">Reason</th>
                <th scope="col">Granted by</th>
                <th scope="col">Expires</th>
              </tr>
            </thead>
            <tbody>
              {exceptions.map((ex) => (
                <tr key={ex.id}>
                  <td><strong>{REQ_KEY_LABELS[ex.requirementKey] ?? ex.requirementKey}</strong></td>
                  <td>{ex.reason}</td>
                  <td>{ex.grantedBy.displayName}</td>
                  <td>{formatDate(ex.expiresAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Actions: Exceptions & Activation */}
      <div className="mt-6 flex gap-4 flex-wrap">
        {!gate.isActivated && (
          <button
            type="button"
            className="button secondary"
            onClick={() => setOpenExceptionForm(!openExceptionForm)}
          >
            {openExceptionForm ? 'Cancel exception' : 'Grant activation exception'}
          </button>
        )}

        {gate.canActivate && !gate.isActivated && (
          <button
            type="button"
            className="button primary"
            onClick={() => setOpenActivateForm(!openActivateForm)}
          >
            {openActivateForm ? 'Cancel activation' : 'Activate client'}
          </button>
        )}
      </div>

      {/* Grant Exception Form */}
      {openExceptionForm && (
        <form onSubmit={handleGrantException} className="form-card mt-4" >
          <h4>Grant reasoned time-limited exception</h4>
          <p className="secondary">
            Exceptions are separate, reasoned, partner/compliance approvals lasting up to 60 days. They do not edit underlying results.
          </p>
          <div className="field">
            <label htmlFor="ex-req">Requirement to except</label>
            <select id="ex-req" name="requirementKey" defaultValue="conflict_check">
              <option value="conflict_check">Conflict search and resolution</option>
              <option value="email_verification">Email contact verification</option>
              <option value="id_verification">Identity and company evidence</option>
              <option value="cdd_compliance">CDD and compliance checks</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="ex-reason">Reason for exception</label>
            <textarea
              id="ex-reason"
              name="reason"
              rows={2}
              required
              minLength={10}
              maxLength={2000}
              placeholder="Provide clear rationale for granting this onboarding exception..."
            />
          </div>
          <div className="field">
            <label htmlFor="ex-duration">Duration</label>
            <select id="ex-duration" name="durationDays" defaultValue="14">
              <option value="7">7 days</option>
              <option value="14">14 days</option>
              <option value="30">30 days</option>
              <option value="60">60 days (maximum)</option>
            </select>
          </div>
          <button type="submit" disabled={saving} className="button primary">
            {saving ? 'Granting…' : 'Confirm exception'}
          </button>
        </form>
      )}

      {/* Activate Client Form */}
      {openActivateForm && (
        <form onSubmit={handleActivateClient} className="form-card mt-4" >
          <h4>Formally activate client onboarding</h4>
          <p className="secondary">
            All mandatory requirements or valid exceptions are in place. Confirming activation permanently records the gate clearance.
          </p>
          <div className="field">
            <label htmlFor="activate-notes">Activation notes (optional)</label>
            <textarea
              id="activate-notes"
              name="notes"
              rows={2}
              maxLength={1000}
              placeholder="e.g. Partner onboarding sign-off..."
            />
          </div>
          <button type="submit" disabled={saving} className="button primary">
            {saving ? 'Activating…' : 'Activate client now'}
          </button>
        </form>
      )}
    </section>
  );
}
