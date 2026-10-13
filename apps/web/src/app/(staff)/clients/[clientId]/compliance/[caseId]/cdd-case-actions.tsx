'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { ErrorSummary } from '@/components/error-summary';
import type { CddEvidence, CddSubject } from '@/lib/compliance';
import type { EvidenceRequest } from '@/lib/onboarding';
import { messagesOf, postJson } from '@/lib/requests';

const RELATIONSHIPS = ['client', 'authorised_representative', 'director_senior_manager', 'beneficial_owner',
  'trustee', 'settlor', 'beneficiary', 'protector', 'funder', 'other_controller'] as const;

export function CddCaseActions({ clientId, caseId, subjects, evidence, requests = [] }:
  { clientId: string; caseId: string; subjects: CddSubject[]; evidence: CddEvidence[]; requests?: EvidenceRequest[] }) {
  const router = useRouter();
  const [errors, setErrors] = useState<string[]>();
  const [sending, setSending] = useState(false);
  const base = `/api/clients/${clientId}/cdd/${caseId}`;
  async function json(path: string, body: unknown) {
    setSending(true); setErrors(undefined);
    try { const response = await postJson(`${base}${path}` as `/api/${string}`, body as Record<string, unknown>); if (!response.ok) { setErrors(await messagesOf(response)); return false; } router.refresh(); return true; }
    finally { setSending(false); }
  }
  async function addSubject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const target = event.currentTarget; const form = new FormData(target); const kind = String(form.get('kind'));
    const details = Object.fromEntries(['name', 'dateOfBirth', 'nationality', 'countryOfResidence', 'legalForm', 'governingLaw', 'registrationNumber', 'registeredOffice', 'principalOffice']
      .map((key) => [key, String(form.get(key) ?? '').trim()]).filter(([, value]) => value));
    if (typeof details.countryOfResidence === 'string') details.countryOfResidence = details.countryOfResidence.toUpperCase();
    if (await json('/subjects', { kind, relationship: form.get('relationship'), details })) target.reset();
  }
  async function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const target = event.currentTarget; const data = new FormData(target);
    for (const [key, value] of [...data.entries()]) if (typeof value === 'string' && !value.trim()) data.delete(key);
    const country = data.get('country'); if (typeof country === 'string') data.set('country', country.toUpperCase());
    setSending(true); setErrors(undefined);
    try { const response = await fetch(`${base}/evidence`, { method: 'POST', body: data }); if (!response.ok) { setErrors(await messagesOf(response)); return; } target.reset(); router.refresh(); }
    finally { setSending(false); }
  }
  async function requestEvidence(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const target = event.currentTarget; const form = new FormData(target);
    const country = String(form.get('country') ?? '').trim().toUpperCase() || null;
    const contactId = String(form.get('contactId') ?? '').trim() || null;
    if (await json('/evidence-requests', {
      evidenceType: form.get('evidenceType'), instructions: form.get('instructions'),
      dueOn: form.get('dueOn'), country, contactId,
    })) target.reset();
  }
  async function reviewEvidence(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const target = event.currentTarget; const form = new FormData(target);
    const selected = requests.find((r) => r.id === form.get('requestId'));
    if (!selected?.submission) return;
    const exceptionNote = String(form.get('exceptionNote') ?? '').trim() || null;
    if (await json('/evidence-reviews', {
      requestId: selected.id,
      evidenceId: selected.submission.evidenceId,
      outcome: form.get('outcome'),
      reason: form.get('reason'),
      exceptionNote,
    })) target.reset();
  }
  async function verify(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = new FormData(event.currentTarget); const nullable = (name: string) => String(form.get(name) ?? '').trim() || null;
    await json('/verifications', { subjectId: form.get('subjectId'), evidenceId: form.get('evidenceId'), sourceType: form.get('sourceType'), country: nullable('country'),
      checkedOn: form.get('checkedOn'), expiresOn: nullable('expiresOn'), method: form.get('method'), outcome: form.get('outcome'), provider: nullable('provider'), service: nullable('service'),
      documentIdentifier: nullable('documentIdentifier'), providerResult: nullable('providerResult'), reliance: null });
  }
  async function ownership(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = new FormData(event.currentTarget);
    await json('/ownership', { ownedSubjectId: form.get('ownedSubjectId'), controllerSubjectId: form.get('controllerSubjectId'),
      ownershipPercent: String(form.get('ownershipPercent') ?? '').trim() || null, controlKind: form.get('controlKind'), details: form.get('details') });
  }
  async function authority(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = new FormData(event.currentTarget);
    await json('/authorities', { representativeSubjectId: form.get('representativeSubjectId'), representedSubjectId: form.get('representedSubjectId'),
      evidenceId: form.get('authorityEvidenceId'), authorityType: form.get('authorityType'), verifiedOn: form.get('verifiedOn'), details: form.get('authorityDetails') });
  }
  async function finalAction(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = new FormData(event.currentTarget);
    const action = ((event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null)?.value;
    if (action === 'submit') await json('/submit', {}); else await json('/abandon', { reason: form.get('abandonReason') });
  }
  return <section aria-labelledby="case-actions-heading"><hr className="rule" /><h2 id="case-actions-heading">Complete this draft</h2>
    {errors && <ErrorSummary messages={errors} />}
    <form aria-label="Add CDD subject" onSubmit={addSubject}><h3>Add person or entity</h3>
      <div className="field"><label className="label" htmlFor="kind">Kind</label><select className="select" id="kind" name="kind"><option value="individual">Individual</option><option value="legal_entity">Legal entity</option></select></div>
      <div className="field"><label className="label" htmlFor="relationship">Relationship</label><select className="select" id="relationship" name="relationship">{RELATIONSHIPS.map((value) => <option key={value} value={value}>{value.replaceAll('_', ' ')}</option>)}</select></div>
      <div className="field"><label className="label" htmlFor="name">Full name or registered name</label><input className="input" id="name" name="name" required maxLength={300} /></div>
      <div className="form-grid"><div className="field"><label className="label" htmlFor="dateOfBirth">Date of birth (individual)</label><input className="input input-date" id="dateOfBirth" name="dateOfBirth" type="date" /></div>
        <div className="field"><label className="label" htmlFor="nationality">Nationality</label><input className="input" id="nationality" name="nationality" maxLength={100} /></div>
        <div className="field"><label className="label" htmlFor="countryOfResidence">Country of residence (two letters)</label><input className="input input-short" id="countryOfResidence" name="countryOfResidence" maxLength={2} /></div>
        <div className="field"><label className="label" htmlFor="legalForm">Legal form (entity)</label><input className="input" id="legalForm" name="legalForm" maxLength={200} /></div>
        <div className="field"><label className="label" htmlFor="governingLaw">Governing law (entity)</label><input className="input" id="governingLaw" name="governingLaw" maxLength={100} /></div>
        <div className="field"><label className="label" htmlFor="registrationNumber">Registration number</label><input className="input" id="registrationNumber" name="registrationNumber" maxLength={100} /></div></div>
      <div className="field"><label className="label" htmlFor="registeredOffice">Registered office (entity)</label><input className="input" id="registeredOffice" name="registeredOffice" maxLength={500} /></div>
      <div className="field"><label className="label" htmlFor="principalOffice">Principal office (entity)</label><input className="input" id="principalOffice" name="principalOffice" maxLength={500} /></div>
      <button className="button" disabled={sending}>Add subject</button></form>

    <form aria-label="Upload CDD evidence" onSubmit={upload}><h3>Upload protected evidence</h3>
      <div className="field"><label className="label" htmlFor="evidenceType">Evidence type</label><input className="input" id="evidenceType" name="evidenceType" required maxLength={100} /></div>
      <div className="form-grid"><div className="field"><label className="label" htmlFor="country">Country (two letters)</label><input className="input input-short" id="country" name="country" maxLength={2} /></div>
        <div className="field"><label className="label" htmlFor="issuedOn">Issued</label><input className="input input-date" id="issuedOn" name="issuedOn" type="date" /></div>
        <div className="field"><label className="label" htmlFor="expiresOn">Expires</label><input className="input input-date" id="expiresOn" name="expiresOn" type="date" /></div></div>
      <div className="field"><label className="label" htmlFor="documentIdentifier">Document identifier</label><input className="input" id="documentIdentifier" name="documentIdentifier" maxLength={500} /></div>
      <div className="field"><label className="label" htmlFor="file">File</label><input className="input" id="file" name="file" type="file" required /></div>
      <button className="button" disabled={sending}>Upload evidence</button></form>

    <form aria-label="Request evidence from client" onSubmit={requestEvidence}><h3>Request evidence from client</h3>
      <div className="field"><label className="label" htmlFor="reqEvidenceType">Evidence type</label><input className="input" id="reqEvidenceType" name="evidenceType" required maxLength={100} /></div>
      <div className="field"><label className="label" htmlFor="reqInstructions">Instructions</label><textarea className="input" id="reqInstructions" name="instructions" rows={3} required minLength={10} maxLength={2000} /></div>
      <div className="form-grid"><div className="field"><label className="label" htmlFor="reqDueOn">Due date</label><input className="input input-date" id="reqDueOn" name="dueOn" type="date" required /></div>
        <div className="field"><label className="label" htmlFor="reqCountry">Country (two letters)</label><input className="input input-short" id="reqCountry" name="country" maxLength={2} /></div></div>
      <button className="button button-secondary" disabled={sending}>Send portal evidence request</button></form>

    {requests.filter((r) => r.submission && !r.review).length > 0 && <form aria-label="Review client evidence submission" onSubmit={reviewEvidence}>
      <h3>Review submitted client evidence</h3>
      <div className="field">
        <label className="label" htmlFor="reviewRequestId">Submitted evidence</label>
        <select className="select" id="reviewRequestId" name="requestId" required>
          {requests.filter((r) => r.submission && !r.review).map((req) => (
            <option key={req.id} value={req.id}>
              {req.evidenceType} (submitted by {req.submission!.uploadedBy.displayName})
            </option>
          ))}
        </select>
      </div>
      <div className="form-grid">
        <div className="field">
          <label className="label" htmlFor="reviewOutcome">Review decision</label>
          <select className="select" id="reviewOutcome" name="outcome" required>
            <option value="accepted">Accepted (Satisfies requirement)</option>
            <option value="rejected">Rejected (Does not satisfy requirement)</option>
          </select>
        </div>
      </div>
      <div className="field">
        <label className="label" htmlFor="reviewReason">Review reason and findings</label>
        <textarea className="input" id="reviewReason" name="reason" rows={3} required minLength={5} maxLength={2000} />
      </div>
      <div className="field">
        <label className="label" htmlFor="reviewExceptionNote">Exception note (if applicable)</label>
        <input className="input" id="reviewExceptionNote" name="exceptionNote" maxLength={2000} />
      </div>
      <button className="button" disabled={sending}>Record review decision</button>
    </form>}

    {!!subjects.length && !!evidence.length && <form aria-label="Record verification" onSubmit={verify}><h3>Record verification</h3>
      <SubjectSelect id="subjectId" name="subjectId" label="Subject" subjects={subjects} /><EvidenceSelect id="evidenceId" name="evidenceId" label="Evidence" evidence={evidence} />
      <div className="field"><label className="label" htmlFor="sourceType">Independent source</label><input className="input" id="sourceType" name="sourceType" required maxLength={100} /></div>
      <div className="form-grid"><div className="field"><label className="label" htmlFor="checkedOn">Checked</label><input className="input input-date" id="checkedOn" name="checkedOn" type="date" required /></div>
        <div className="field"><label className="label" htmlFor="method">Method</label><select className="select" id="method" name="method">{['manual', 'electronic', 'certified_copy', 'in_person', 'other'].map((value) => <option key={value} value={value}>{value.replaceAll('_', ' ')}</option>)}</select></div>
        <div className="field"><label className="label" htmlFor="outcome">Outcome</label><select className="select" id="outcome" name="outcome"><option value="verified">Verified</option><option value="failed">Failed</option><option value="inconclusive">Inconclusive</option></select></div></div>
      <details><summary>Optional verification details</summary><div className="field"><label className="label" htmlFor="provider">Provider (required for electronic)</label><input className="input" id="provider" name="provider" /></div><div className="field"><label className="label" htmlFor="service">Service (required for electronic)</label><input className="input" id="service" name="service" /></div><div className="field"><label className="label" htmlFor="providerResult">Provider result</label><textarea className="input" id="providerResult" name="providerResult" rows={3} /></div><input type="hidden" name="expiresOn" /><input type="hidden" name="documentIdentifier" /><input type="hidden" name="country" /></details>
      <button className="button" disabled={sending}>Record result</button></form>}

    {subjects.length >= 2 && <form aria-label="Record ownership or control" onSubmit={ownership}><h3>Record ownership or control</h3><SubjectSelect id="ownedSubjectId" name="ownedSubjectId" label="Owned entity" subjects={subjects} /><SubjectSelect id="controllerSubjectId" name="controllerSubjectId" label="Owner or controller" subjects={subjects} /><div className="field"><label className="label" htmlFor="ownershipPercent">Ownership percent</label><input className="input input-short" id="ownershipPercent" name="ownershipPercent" /></div><div className="field"><label className="label" htmlFor="controlKind">Control kind</label><select className="select" id="controlKind" name="controlKind">{['ownership', 'voting_rights', 'appointment_rights', 'significant_influence', 'other'].map((value) => <option key={value}>{value}</option>)}</select></div><div className="field"><label className="label" htmlFor="details">Evidence and explanation</label><textarea className="input" id="details" name="details" rows={3} required /></div><button className="button" disabled={sending}>Record control</button></form>}

    {subjects.length >= 2 && !!evidence.length && <form aria-label="Record authority to act" onSubmit={authority}><h3>Record authority to act</h3><SubjectSelect id="representativeSubjectId" name="representativeSubjectId" label="Representative" subjects={subjects} /><SubjectSelect id="representedSubjectId" name="representedSubjectId" label="Represented person or entity" subjects={subjects} /><EvidenceSelect id="authorityEvidenceId" name="authorityEvidenceId" label="Authority evidence" evidence={evidence} /><div className="field"><label className="label" htmlFor="authorityType">Authority type</label><input className="input" id="authorityType" name="authorityType" required /></div><div className="field"><label className="label" htmlFor="verifiedOn">Verified</label><input className="input input-date" id="verifiedOn" name="verifiedOn" type="date" required /></div><div className="field"><label className="label" htmlFor="authorityDetails">Details</label><textarea className="input" id="authorityDetails" name="authorityDetails" rows={3} required /></div><button className="button" disabled={sending}>Record authority</button></form>}

    <form aria-label="Finish CDD case" onSubmit={finalAction}><h3>Finish this version</h3><div className="field"><label className="label" htmlFor="abandonReason">Reason if abandoning</label><textarea className="input" id="abandonReason" name="abandonReason" rows={2} /></div><div className="actions"><button className="button" name="action" value="submit" disabled={sending}>Submit immutable case</button><button className="button button-danger" name="action" value="abandon" disabled={sending}>Abandon draft</button></div></form>
  </section>;
}

function SubjectSelect({ id, name, label, subjects }: { id: string; name: string; label: string; subjects: CddSubject[] }) {
  return <div className="field"><label className="label" htmlFor={id}>{label}</label><select className="select" id={id} name={name}>{subjects.map((item) => <option key={item.id} value={item.id}>{String(item.details.name ?? item.id)}</option>)}</select></div>;
}
function EvidenceSelect({ id, name, label, evidence }: { id: string; name: string; label: string; evidence: CddEvidence[] }) {
  return <div className="field"><label className="label" htmlFor={id}>{label}</label><select className="select" id={id} name={name}>{evidence.map((item) => <option key={item.id} value={item.id}>{item.fileName}</option>)}</select></div>;
}
