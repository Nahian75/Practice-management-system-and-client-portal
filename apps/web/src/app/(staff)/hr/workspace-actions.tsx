'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { ErrorSummary } from '@/components/error-summary';
import type { HrAccess, HrDirectoryMember, HrRetentionRule } from '@/lib/hr';
import { messagesOf, postJson } from '@/lib/requests';

interface PersonChoice extends HrDirectoryMember { personId: string }

export function HrWorkspaceActions({ access, directory, people, rules }: { access: HrAccess; directory: HrDirectoryMember[];
  people: PersonChoice[]; rules: HrRetentionRule[] }) {
  const router = useRouter(); const [errors, setErrors] = useState<string[]>(); const [sending, setSending] = useState(false);
  async function send(event: FormEvent<HTMLFormElement>, path: `/api/${string}`, body: (form: FormData) => Record<string, unknown>, go?: (id: string) => string) {
    event.preventDefault(); const target = event.currentTarget; const form = new FormData(target); setSending(true); setErrors(undefined);
    try { const response = await postJson(path, body(form)); if (!response.ok) { setErrors(await messagesOf(response)); return; }
      const result = await response.json() as { id?: string; personId?: string }; target.reset();
      if (go && (result.id ?? result.personId)) router.push(go((result.id ?? result.personId)!)); else router.refresh();
    } finally { setSending(false); }
  }
  const text = (form: FormData, name: string) => String(form.get(name) ?? '').trim();
  const unlinked = directory.filter((person) => !person.personId);
  return <section aria-labelledby="new-work-heading"><h2 id="new-work-heading">Start HR work</h2>{errors && <ErrorSummary messages={errors} />}
    {access.canManagePeople && !!unlinked.length && <details><summary>Create a personnel record</summary><form aria-label="Create personnel record"
      onSubmit={(event) => void send(event, '/api/hr/people', (form) => ({ accountId: form.get('accountId') }), (id) => `/hr/people/${id}`)}>
      <Choice id="newPersonAccount" name="accountId" label="Active staff account" items={unlinked.map((item) => ({ id: item.accountId, label: item.displayName }))} />
      <button className="button" disabled={sending}>Create personnel record</button></form></details>}
    {access.canManageLeave && <details><summary>Create a leave policy version</summary><form aria-label="Create leave policy"
      onSubmit={(event) => void send(event, '/api/hr/leave/policies', (form) => ({ effectiveFrom: text(form, 'effectiveFrom'),
        leaveYearMonth: Number(form.get('leaveYearMonth')), leaveYearDay: Number(form.get('leaveYearDay')),
        standardEntitlementMinutes: Number(form.get('standardEntitlementMinutes')), carryOverLimitMinutes: Number(form.get('carryOverLimitMinutes')),
        bookingNoticeDays: Number(form.get('bookingNoticeDays')), annualApprovalRoute: form.get('annualApprovalRoute') }))}>
      <Field id="policyEffectiveFrom" name="effectiveFrom" label="Effective from" type="date" />
      <Field id="leaveYearMonth" name="leaveYearMonth" label="Leave year start month" type="number" value="1" />
      <Field id="leaveYearDay" name="leaveYearDay" label="Leave year start day" type="number" value="1" />
      <Field id="standardEntitlementMinutes" name="standardEntitlementMinutes" label="Standard entitlement in minutes" type="number" />
      <Field id="carryOverLimitMinutes" name="carryOverLimitMinutes" label="Carry-over limit in minutes" type="number" value="0" />
      <Field id="bookingNoticeDays" name="bookingNoticeDays" label="Booking notice days" type="number" value="0" />
      <Select id="annualApprovalRoute" name="annualApprovalRoute" label="Annual-leave approval" values={['manager_or_hr','hr_only']} />
      <button className="button" disabled={sending}>Record policy version</button></form></details>}
    {access.canManageCases && <details><summary>Open a confidential case</summary><form aria-label="Open confidential HR case"
      onSubmit={(event) => void send(event, '/api/hr/cases', (form) => ({ personId: form.get('personId'), kind: form.get('kind'),
        raisedByPersonId: text(form, 'raisedByPersonId') || null, policyVersion: text(form, 'policyVersion'),
        dueOn: text(form, 'dueOn') || null, issue: text(form, 'issue') }), (id) => `/people/cases/${id}`)}>
      <PersonChoice id="casePerson" people={people} /><Select id="caseKind" name="kind" label="Case kind" values={['grievance','disciplinary','capability']} />
      <Choice id="raisedByPersonId" name="raisedByPersonId" label="Raised by (optional)" empty="Not recorded"
        items={people.map((item) => ({ id: item.personId, label: item.displayName }))} />
      <Field id="policyVersion" name="policyVersion" label="Policy version" /><Field id="caseDueOn" name="dueOn" label="Due (optional)" type="date" />
      <Area id="caseIssue" name="issue" label="Issue" /><button className="button" disabled={sending}>Open encrypted case</button></form></details>}
    {access.canManageRetention && <><details><summary>Create a retention rule version</summary><form aria-label="Create HR retention rule"
      onSubmit={(event) => void send(event, '/api/hr/retention/rules', (form) => ({ category: form.get('category'),
        effectiveFrom: text(form, 'effectiveFrom'), reviewAfterMonths: Number(form.get('reviewAfterMonths')),
        retainMonths: Number(form.get('retainMonths')), governingRule: text(form, 'governingRule'), rationale: text(form, 'rationale') }))}>
      <Select id="retentionCategory" name="category" label="Category" values={['personal','employment','leave','health','right_to_work','competence','case']} />
      <Field id="ruleEffectiveFrom" name="effectiveFrom" label="Effective from" type="date" />
      <Field id="reviewAfterMonths" name="reviewAfterMonths" label="Review after months" type="number" />
      <Field id="retainMonths" name="retainMonths" label="Dispose after months" type="number" />
      <Field id="governingRule" name="governingRule" label="Governing rule" /><Area id="rationale" name="rationale" label="Rationale" />
      <button className="button" disabled={sending}>Record rule version</button></form></details>
      {!!rules.length && <details><summary>Schedule a record for retention review</summary><form aria-label="Create HR retention schedule"
        onSubmit={(event) => void send(event, '/api/hr/retention/schedules', (form) => ({ personId: form.get('personId'), ruleId: form.get('ruleId'),
          sourceId: text(form, 'sourceId') || null, basisOn: text(form, 'basisOn'), evidence: text(form, 'evidence') }), (id) => `/hr/retention/${id}`)}>
        <PersonChoice id="schedulePerson" people={people} /><Choice id="ruleId" name="ruleId" label="Rule version"
          items={rules.map((item) => ({ id: item.id, label: `${item.category}, version ${item.version}` }))} />
        <Field id="sourceId" name="sourceId" label="Case source ID (case category only)" /><Field id="basisOn" name="basisOn" label="Latest source date" type="date" />
        <Area id="scheduleEvidence" name="evidence" label="Evidence for the basis date" />
        <button className="button" disabled={sending}>Create schedule</button></form></details>}</>}
    {access.canManageExports && <details><summary>Prepare a fixed HR export</summary><form aria-label="Prepare HR export"
      onSubmit={(event) => void send(event, '/api/hr/exports', (form) => ({ personId: form.get('personId'), purpose: form.get('purpose'),
        scopes: form.getAll('scopes'), reason: text(form, 'reason') }), (id) => `/hr/exports/${id}`)}>
      <PersonChoice id="exportPerson" people={people} /><Select id="exportPurpose" name="purpose" label="Purpose" values={['worker_access','litigation','regulator']} />
      <fieldset className="fieldset"><legend>Included scopes</legend><div className="checkbox">{['personal','employment','leave','health','vetting','competence','cases'].map((scope) =>
        <label key={scope}><input type="checkbox" name="scopes" value={scope} />{scope}</label>)}</div></fieldset>
      <Area id="exportReason" name="reason" label="Reason and scope justification" />
      <button className="button" disabled={sending}>Prepare encrypted fixed bundle</button></form></details>}
  </section>;
}

function PersonChoice({ id, people }: { id: string; people: PersonChoice[] }) { return <Choice id={id} name="personId" label="Person"
  items={people.map((item) => ({ id: item.personId, label: item.displayName }))} />; }
function Choice({ id, name, label, items, empty }: { id: string; name: string; label: string;
  items: Array<{ id: string; label: string }>; empty?: string }) { return <div className="field"><label className="label" htmlFor={id}>{label}</label>
  <select className="select" id={id} name={name} defaultValue={empty ? '' : undefined}>{empty && <option value="">{empty}</option>}
    {items.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></div>; }
function Field({ id, name, label, type = 'text', value }: { id: string; name: string; label: string; type?: string; value?: string }) { return <div className="field">
  <label className="label" htmlFor={id}>{label}</label><input className="input" id={id} name={name} type={type} defaultValue={value} /></div>; }
function Area({ id, name, label }: { id: string; name: string; label: string }) { return <div className="field"><label className="label" htmlFor={id}>{label}</label>
  <textarea className="input" id={id} name={name} rows={4} required minLength={3} /></div>; }
function Select({ id, name, label, values }: { id: string; name: string; label: string; values: string[] }) { return <div className="field">
  <label className="label" htmlFor={id}>{label}</label><select className="select" id={id} name={name}>{values.map((value) =>
    <option key={value} value={value}>{value.replaceAll('_', ' ')}</option>)}</select></div>; }
