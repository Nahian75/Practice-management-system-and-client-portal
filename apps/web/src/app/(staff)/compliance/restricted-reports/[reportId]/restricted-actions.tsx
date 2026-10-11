'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { ErrorSummary } from '@/components/error-summary';
import type { RestrictedReport } from '@/lib/compliance';
import { messagesOf, postJson } from '@/lib/requests';

export function RestrictedActions({ report }: { report: RestrictedReport }) {
  const router = useRouter(); const [errors, setErrors] = useState<string[]>(); const [sending, setSending] = useState(false);
  async function send(path: `/api/${string}`, body: Record<string, unknown>) {
    setSending(true); setErrors(undefined);
    try { const response = await postJson(path, body); if (!response.ok) { setErrors(await messagesOf(response)); return false; }
      router.refresh(); return true; } finally { setSending(false); }
  }
  async function decide(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = new FormData(event.currentTarget); const grounds = String(form.get('legalGrounds') ?? '').trim();
    if (grounds.length < 20) { setErrors(['Enter the legal grounds for the permanent decision']); return; }
    await send(`/api/compliance/restricted-reports/${report.id}/decision`, { externalReportRequired: form.get('externalReportRequired') === 'yes',
      legalGrounds: grounds, imposeHold: form.get('imposeHold') === 'on' });
  }
  async function external(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = new FormData(event.currentTarget); const submittedAt = instant(form.get('submittedAt'));
    if (!submittedAt || String(form.get('reference') ?? '').trim() === '') { setErrors(['Enter the external reference and actual submission date and time']); return; }
    await send(`/api/compliance/restricted-reports/${report.id}/external-report`, { kind: form.get('kind'), reference: String(form.get('reference')).trim(),
      submittedAt, damlDatfRequested: form.get('damlDatfRequested') === 'on' });
  }
  async function status(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = new FormData(event.currentTarget); const receivedAt = instant(form.get('receivedAt'));
    const legalBasis = String(form.get('legalBasis') ?? '').trim();
    if (!receivedAt || legalBasis.length < 20 || String(form.get('externalReference') ?? '').trim() === '') {
      setErrors(['Enter the received time, external reference and full legal basis']); return;
    }
    await send(`/api/compliance/restricted-reports/${report.id}/external-report/${report.externalReport!.id}/events`, {
      outcome: form.get('outcome'), receivedAt, expiresAt: instant(form.get('expiresAt')), externalReference: String(form.get('externalReference')).trim(),
      permittedActivity: String(form.get('permittedActivity') ?? '').trim() || null, legalBasis,
    });
  }
  async function exportRecord(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = new FormData(event.currentTarget); const reason = String(form.get('exportReason') ?? '').trim();
    if (reason.length < 10) { setErrors(['Enter the regulatory purpose for the protected export']); return; }
    setSending(true); setErrors(undefined);
    try { const response = await postJson(`/api/compliance/restricted-reports/${report.id}/exports`, { reason });
      if (!response.ok) { setErrors(await messagesOf(response)); return; }
      const created = await response.json() as { id: string };
      window.location.assign(`/api/compliance/restricted-reports/${report.id}/exports/${created.id}/content`);
    } finally { setSending(false); }
  }
  return <section aria-labelledby="actions-heading"><h2 id="actions-heading">Nominated-officer actions</h2>{errors && <ErrorSummary messages={errors} />}
    {!report.decision && <form aria-label="Record permanent nominated-officer decision" onSubmit={decide} noValidate>
      <fieldset className="fieldset"><legend>Is an external report required?</legend><label><input type="radio" name="externalReportRequired" value="yes" defaultChecked /> Yes</label>{' '}<label><input type="radio" name="externalReportRequired" value="no" /> No</label></fieldset>
      <div className="field"><label className="label" htmlFor="legalGrounds">Legal grounds</label><textarea className="input" id="legalGrounds" name="legalGrounds" rows={6} maxLength={100000} /></div>
      <div className="field"><label><input type="checkbox" name="imposeHold" /> Impose a generic protected operational hold</label></div>
      <button className="button" type="submit" disabled={sending}>Record permanent decision</button></form>}
    {report.decision?.externalReportRequired && !report.externalReport && <form aria-label="Record external filing" onSubmit={external} noValidate>
      <div className="field"><label className="label" htmlFor="kind">Filing kind</label><select className="select" id="kind" name="kind"><option value="sar">SAR</option><option value="terrorist_financing_report">Terrorist-financing report</option></select></div>
      <div className="field"><label className="label" htmlFor="reference">External acknowledgement or reference</label><input className="input" id="reference" name="reference" maxLength={500} /></div>
      <div className="field"><label className="label" htmlFor="submittedAt">Actually submitted at</label><input className="input" id="submittedAt" name="submittedAt" type="datetime-local" /></div>
      <div className="field"><label><input type="checkbox" name="damlDatfRequested" /> DAML or DATF was requested</label></div>
      <button className="button" type="submit" disabled={sending}>Record external filing</button></form>}
    {report.externalReport?.damlDatfRequested && <form aria-label="Record DAML or DATF event" onSubmit={status} noValidate>
      <div className="field"><label className="label" htmlFor="outcome">Outcome</label><select className="select" id="outcome" name="outcome"><option value="requested">Requested</option><option value="granted">Granted</option><option value="refused">Refused</option><option value="withdrawn">Withdrawn</option><option value="expired">Expired</option></select></div>
      <div className="field"><label className="label" htmlFor="receivedAt">Received at</label><input className="input" id="receivedAt" name="receivedAt" type="datetime-local" /></div>
      <div className="field"><label className="label" htmlFor="expiresAt">Expires at (optional)</label><input className="input" id="expiresAt" name="expiresAt" type="datetime-local" /></div>
      <div className="field"><label className="label" htmlFor="externalReference">External reference</label><input className="input" id="externalReference" name="externalReference" maxLength={500} /></div>
      <div className="field"><label className="label" htmlFor="permittedActivity">Permitted activity (optional)</label><textarea className="input" id="permittedActivity" name="permittedActivity" rows={3} maxLength={10000} /></div>
      <div className="field"><label className="label" htmlFor="legalBasis">Legal basis</label><textarea className="input" id="legalBasis" name="legalBasis" rows={5} maxLength={100000} /></div>
      <button className="button" type="submit" disabled={sending}>Record permanent status event</button></form>}
    <form aria-label="Generate protected regulatory export" onSubmit={exportRecord} noValidate><h3>Protected export</h3>
      <div className="field"><label className="label" htmlFor="exportReason">Regulatory purpose</label><textarea className="input" id="exportReason" name="exportReason" rows={3} maxLength={500} /></div>
      <button className="button" type="submit" disabled={sending}>Generate and download protected export</button></form>
  </section>;
}

function instant(value: FormDataEntryValue | null): string | null {
  const text = String(value ?? '').trim(); if (!text) return null;
  const date = new Date(text); return Number.isNaN(date.valueOf()) ? null : date.toISOString();
}
