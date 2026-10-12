'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { ErrorSummary } from '@/components/error-summary';
import type { HrAccess, HrAdjustments, HrCompetence, HrDirectoryMember, HrLeaveRecord, HrLifecycle,
  HrPersonRecord, HrVetting } from '@/lib/hr';
import { messagesOf, postJson, putJson } from '@/lib/requests';

export function HrPersonActions({ person, access, directory, leave, adjustments, lifecycle, vetting, competence }: {
  person: HrPersonRecord; access: HrAccess; directory: HrDirectoryMember[]; leave?: HrLeaveRecord;
  adjustments?: HrAdjustments; lifecycle?: HrLifecycle; vetting?: HrVetting; competence?: HrCompetence;
}) {
  const router = useRouter(); const [errors, setErrors] = useState<string[]>(); const [sending, setSending] = useState(false);
  const personId = person.personId;
  async function send(event: FormEvent<HTMLFormElement>, path: `/api/${string}`, body: (form: FormData) => Record<string, unknown>, method: 'post' | 'put' = 'post') {
    event.preventDefault(); const target = event.currentTarget; const form = new FormData(target); setSending(true); setErrors(undefined);
    try { const request = method === 'put' ? putJson(path, body(form)) : postJson(path.replace(':id', text(form, 'id')) as `/api/${string}`, body(form));
      const response = await request; if (!response.ok) { setErrors(await messagesOf(response)); return; } router.refresh();
    } finally { setSending(false); }
  }
  const text = (form: FormData, name: string) => String(form.get(name) ?? '').trim();
  const nullable = (form: FormData, name: string) => text(form, name) || null;
  const activeEngagement = person.engagements.find((item) => !item.endedOn);
  const pendingLeave = leave?.requests.filter((item) => item.state === 'pending') ?? [];
  const cancellableLeave = leave?.requests.filter((item) => item.state === 'pending' || item.state === 'approved') ?? [];
  const payableLeave = leave?.requests.filter((item) => item.state === 'approved'
    && !leave.holidayPay.some((pay) => pay.leaveRequestId === item.id)) ?? [];
  const pendingAdjustments = adjustments?.adjustments.filter((item) => !item.decisionId) ?? [];
  const agreedAdjustments = adjustments?.adjustments.filter((item) => item.decisionId && item.outcome === 'agreed') ?? [];
  const identityFiles = person.files.filter((item) => item.category === 'identity');

  async function upload(event: FormEvent<HTMLFormElement>) { event.preventDefault(); const target = event.currentTarget;
    setSending(true); setErrors(undefined); try { const response = await fetch(`/api/hr/people/${personId}/files`, { method: 'POST', body: new FormData(target) });
      if (!response.ok) { setErrors(await messagesOf(response)); return; } target.reset(); router.refresh();
    } finally { setSending(false); } }

  return <section aria-labelledby="hr-actions-heading"><h2 id="hr-actions-heading">HR actions</h2>{errors && <ErrorSummary messages={errors} />}
    {access.canManagePeople && <>
      <details><summary>Update contact details</summary><form aria-label="Update personnel contact details"
        onSubmit={(event) => void send(event, `/api/hr/people/${personId}/contact`, (form) => { const address = ['line1','line2','town','postcode'].some((name) => text(form, name));
          const emergency = ['emergencyName','emergencyRelationship','emergencyPhone'].some((name) => text(form, name)); return {
          personalEmail: nullable(form, 'personalEmail'), phone: nullable(form, 'phone'), address: address ? { line1: text(form, 'line1'),
            line2: nullable(form, 'line2'), town: text(form, 'town'), postcode: text(form, 'postcode'), country: text(form, 'country') } : null,
          emergencyContact: emergency ? { name: text(form, 'emergencyName'), relationship: text(form, 'emergencyRelationship'), phone: text(form, 'emergencyPhone') } : null }; }, 'put')}>
        <Field id="hrPersonalEmail" name="personalEmail" label="Personal email" type="email" value={person.contact.personalEmail} />
        <Field id="hrPhone" name="phone" label="Phone" value={person.contact.phone} /><Field id="hrLine1" name="line1" label="Address line 1" value={person.contact.address?.line1} />
        <Field id="hrLine2" name="line2" label="Address line 2" value={person.contact.address?.line2} /><Field id="hrTown" name="town" label="Town" value={person.contact.address?.town} />
        <Field id="hrPostcode" name="postcode" label="Postcode" value={person.contact.address?.postcode} /><Field id="hrCountry" name="country" label="Country code" value={person.contact.address?.country ?? 'GB'} />
        <Field id="hrEmergencyName" name="emergencyName" label="Emergency contact name" value={person.contact.emergencyContact?.name} />
        <Field id="hrEmergencyRelationship" name="emergencyRelationship" label="Relationship" value={person.contact.emergencyContact?.relationship} />
        <Field id="hrEmergencyPhone" name="emergencyPhone" label="Emergency contact phone" value={person.contact.emergencyContact?.phone} />
        <button className="button" disabled={sending}>Save new contact version</button></form></details>
      <details><summary>Update date of birth</summary><form aria-label="Update personnel private details"
        onSubmit={(event) => void send(event, `/api/hr/people/${personId}/private`, (form) => ({ dateOfBirth: nullable(form, 'dateOfBirth') }), 'put')}>
        <Field id="hrDateOfBirth" name="dateOfBirth" label="Date of birth" type="date" value={person.privateDetails.dateOfBirth} />
        <button className="button" disabled={sending}>Save new private-details version</button></form></details>
      {!activeEngagement ? <details><summary>Create an engagement</summary><form aria-label="Create engagement"
        onSubmit={(event) => void send(event, `/api/hr/people/${personId}/engagements`, (form) => ({ kind: form.get('kind'), startedOn: text(form, 'startedOn'),
          jobTitle: text(form, 'jobTitle'), team: nullable(form, 'team'), workLocation: nullable(form, 'workLocation'), pattern: workPattern(form) }))}>
        <Select id="engagementKind" name="kind" label="Engagement kind" values={['employee','worker','llp_partner','equity_partner','consultant','apprentice','trainee']} />
        <Field id="engagementStartedOn" name="startedOn" label="Started" type="date" /><Field id="engagementJobTitle" name="jobTitle" label="Job title" />
        <Field id="engagementTeam" name="team" label="Team (optional)" /><Field id="engagementLocation" name="workLocation" label="Work location (optional)" />
        <PatternFields prefix="engagement" /><button className="button" disabled={sending}>Create engagement</button></form></details> : <>
        <details><summary>Record new employment terms</summary><form aria-label="Record employment terms"
          onSubmit={(event) => void send(event, `/api/hr/people/${personId}/terms`, (form) => ({ engagementId: activeEngagement.id,
            effectiveOn: text(form, 'effectiveOn'), jobTitle: text(form, 'jobTitle'), team: nullable(form, 'team'), workLocation: nullable(form, 'workLocation') }))}>
          <Field id="termsEffectiveOn" name="effectiveOn" label="Effective from" type="date" /><Field id="termsJobTitle" name="jobTitle" label="Job title" />
          <Field id="termsTeam" name="team" label="Team (optional)" /><Field id="termsLocation" name="workLocation" label="Work location (optional)" />
          <button className="button" disabled={sending}>Record terms</button></form></details>
        <details><summary>Record a work pattern</summary><form aria-label="Record work pattern"
          onSubmit={(event) => void send(event, `/api/hr/people/${personId}/work-patterns`, (form) => ({ engagementId: activeEngagement.id,
            effectiveOn: text(form, 'effectiveOn'), pattern: workPattern(form) }))}>
          <Field id="patternEffectiveOn" name="effectiveOn" label="Effective from" type="date" /><PatternFields prefix="pattern" />
          <button className="button" disabled={sending}>Record work pattern</button></form></details>
        <details><summary>Assign or clear manager</summary><form aria-label="Record manager assignment"
          onSubmit={(event) => void send(event, `/api/hr/people/${personId}/manager`, (form) => ({ managerPersonId: nullable(form, 'managerPersonId'), effectiveOn: text(form, 'effectiveOn') }))}>
          <Choice id="managerPersonId" name="managerPersonId" label="Manager" empty="Clear manager" items={directory.filter((item) => item.personId && item.personId !== personId)
            .map((item) => ({ id: item.personId!, label: item.displayName }))} /><Field id="managerEffectiveOn" name="effectiveOn" label="Effective from" type="date" />
          <button className="button" disabled={sending}>Record manager event</button></form></details>
        <details><summary>End engagement</summary><form aria-label="End engagement"
          onSubmit={(event) => void send(event, `/api/hr/people/${personId}/end-engagement`, (form) => ({ engagementId: activeEngagement.id,
            endedOn: text(form, 'endedOn'), reason: text(form, 'reason') }))}>
          <Field id="engagementEndedOn" name="endedOn" label="Ended" type="date" /><Area id="engagementEndReason" name="reason" label="Reason" />
          <button className="button button-warning" disabled={sending}>End engagement</button></form></details></>}
      <details><summary>Upload a private HR file</summary><form aria-label="Upload HR file" onSubmit={upload}>
        <Select id="fileCategory" name="category" label="Category" values={['contract','terms','identity','personal','other']} />
        <div className="field"><label className="label" htmlFor="workerVisible">Worker access</label><select className="select" id="workerVisible" name="workerVisible">
          <option value="false">HR only</option><option value="true">Worker may download</option></select></div>
        <div className="field"><label className="label" htmlFor="hrFile">File</label><input className="input" id="hrFile" name="file" type="file" required /></div>
        <button className="button" disabled={sending}>Scan, encrypt and store</button></form></details>
      {!!person.corrections.filter((item) => !item.outcome).length && <details><summary>Decide a correction request</summary><form aria-label="Decide correction request"
        onSubmit={(event) => void send(event, `/api/hr/people/${personId}/corrections/:id/decision`, (form) => ({ outcome: form.get('outcome'), response: text(form, 'response') }))}>
        <Choice id="correctionId" name="id" label="Request" items={person.corrections.filter((item) => !item.outcome).map((item) => ({ id: item.id, label: `${item.category}: ${item.request}` }))} />
        <Select id="correctionOutcome" name="outcome" label="Outcome" values={['resolved','rejected']} /><Area id="correctionResponse" name="response" label="Response" />
        <button className="button" disabled={sending}>Record permanent decision</button></form></details>}
    </>}

    {access.canManageLeave && leave && <>
      <details><summary>Request leave for this person</summary><form aria-label="Request personnel leave"
        onSubmit={(event) => void send(event, `/api/hr/people/${personId}/leave`, (form) => ({ kind: form.get('kind'),
          startsOn: text(form, 'startsOn'), endsOn: text(form, 'endsOn'), reason: text(form, 'reason') }))}>
        <Select id="hrLeaveKind" name="kind" label="Leave kind" values={['annual','family','compassionate','unpaid','other']} />
        <Field id="hrLeaveStartsOn" name="startsOn" label="Starts" type="date" /><Field id="hrLeaveEndsOn" name="endsOn" label="Ends" type="date" />
        <Area id="hrLeaveReason" name="reason" label="Reason" /><button className="button" disabled={sending}>Submit leave request</button></form></details>
      <details><summary>Adjust leave entitlement</summary><form aria-label="Adjust leave entitlement"
        onSubmit={(event) => void send(event, `/api/hr/people/${personId}/leave/entitlement`, (form) => ({ leaveYearStart: text(form, 'leaveYearStart'),
          kind: form.get('kind'), minutes: Number(form.get('minutes')), reason: text(form, 'reason') }))}>
        <Field id="leaveYearStart" name="leaveYearStart" label="Leave year starts" type="date" />
        <Select id="entitlementKind" name="kind" label="Entry kind" values={['opening_grant','accrual','adjustment','carry_over','leaving_adjustment']} />
        <Field id="entitlementMinutes" name="minutes" label="Signed minutes" type="number" /><Area id="entitlementReason" name="reason" label="Reason" />
        <button className="button" disabled={sending}>Record ledger entry</button></form></details>
      {!!pendingLeave.length && <details><summary>Decide pending leave</summary><form aria-label="Decide personnel leave"
        onSubmit={(event) => void send(event, '/api/hr/leave/requests/:id/decision', (form) => ({ action: form.get('action'), reason: text(form, 'reason') }))}>
        <Choice id="leaveRequestId" name="id" label="Request" items={pendingLeave.map((item) => ({ id: item.id, label: `${item.kind}: ${item.startsOn} to ${item.endsOn}` }))} />
        <Select id="leaveDecision" name="action" label="Decision" values={['approved','refused']} /><Area id="leaveDecisionReason" name="reason" label="Decision reason" />
        <button className="button" disabled={sending}>Record decision</button></form></details>}
      {!!cancellableLeave.length && <details><summary>Cancel a leave request</summary><form aria-label="Cancel personnel leave"
        onSubmit={(event) => void send(event, '/api/hr/leave/requests/:id/cancel', (form) => ({ reason: text(form, 'reason') }))}>
        <Choice id="cancelLeaveRequestId" name="id" label="Request" items={cancellableLeave.map((item) => ({ id: item.id,
          label: `${item.kind}: ${item.startsOn} to ${item.endsOn} (${item.state})` }))} />
        <Area id="cancelLeaveReason" name="reason" label="Cancellation reason" /><button className="button" disabled={sending}>Cancel request</button></form></details>}
      {!!payableLeave.length && <details><summary>Record holiday-pay evidence</summary><form aria-label="Record holiday pay"
        onSubmit={(event) => void send(event, `/api/hr/people/${personId}/leave/holiday-pay`, (form) => ({ requestId: form.get('requestId'),
          periodStartsOn: text(form, 'periodStartsOn'), periodEndsOn: text(form, 'periodEndsOn'), amountPence: Number(form.get('amountPence')),
          basis: form.get('basis'), includedElements: form.getAll('elementName').map((name, index) => ({ name: String(name).trim(),
            amountPence: Number(form.getAll('elementAmountPence')[index]) })) }))}>
        <Choice id="holidayPayRequestId" name="requestId" label="Approved leave" items={payableLeave.map((item) => ({ id: item.id,
          label: `${item.kind}: ${item.startsOn} to ${item.endsOn}` }))} />
        <Field id="payPeriodStartsOn" name="periodStartsOn" label="Pay period starts" type="date" /><Field id="payPeriodEndsOn" name="periodEndsOn" label="Pay period ends" type="date" />
        <Field id="holidayPayAmountPence" name="amountPence" label="Total paid (pence)" type="number" />
        <Select id="holidayPayBasis" name="basis" label="Payroll basis" values={['normal','basic','rolled_up','other']} />
        <HolidayPayElements /><p className="secondary">The component amounts must add up to the total supplied by payroll. Stass does not calculate the lawful rate.</p>
        <button className="button" disabled={sending}>Record payroll evidence</button></form></details>}
      <details><summary>Record sickness administration</summary><form aria-label="Record personnel sickness"
        onSubmit={(event) => void send(event, `/api/hr/people/${personId}/sickness`, (form) => ({ startedOn: text(form, 'startedOn'), endedOn: nullable(form, 'endedOn'),
          notifiedAt: new Date(text(form, 'notifiedAt')).toISOString(), fitnessStatus: form.get('fitnessStatus') }))}>
        <Field id="sicknessStartedOn" name="startedOn" label="Started" type="date" /><Field id="sicknessEndedOn" name="endedOn" label="Ended (optional)" type="date" />
        <Field id="sicknessNotifiedAt" name="notifiedAt" label="Notified date and time" type="datetime-local" />
        <Select id="fitnessStatus" name="fitnessStatus" label="Operational fitness" values={['fit','not_fit','may_be_fit','not_assessed']} />
        <button className="button" disabled={sending}>Record sickness</button></form></details>
    </>}

    {access.canManageHealth && adjustments && <>
      <details><summary>Record restricted health evidence</summary><form aria-label="Record restricted health evidence"
        onSubmit={(event) => void send(event, `/api/hr/people/${personId}/health`, (form) => ({ kind: form.get('kind'), validFrom: nullable(form, 'validFrom'),
          validTo: nullable(form, 'validTo'), details: text(form, 'details') }))}>
        <Select id="healthKind" name="kind" label="Evidence kind" values={['sickness_detail','fit_note','occupational_health','adjustment_ground']} />
        <Field id="healthValidFrom" name="validFrom" label="Valid from (optional)" type="date" /><Field id="healthValidTo" name="validTo" label="Valid to (optional)" type="date" />
        <Area id="healthDetails" name="details" label="Restricted details" /><button className="button" disabled={sending}>Record encrypted evidence</button></form></details>
      {!!pendingAdjustments.length && <details><summary>Decide an adjustment request</summary><form aria-label="Decide workplace adjustment"
        onSubmit={(event) => void send(event, '/api/hr/adjustments/:id/decision', (form) => { const outcome = text(form, 'outcome'); return { outcome,
          reason: text(form, 'reason'), operationalInstruction: outcome === 'agreed' ? text(form, 'operationalInstruction') : null,
          effectiveOn: outcome === 'agreed' ? text(form, 'effectiveOn') : null, reviewOn: outcome === 'agreed' ? nullable(form, 'reviewOn') : null }; })}>
        <Choice id="adjustmentRequestId" name="id" label="Request" items={pendingAdjustments.map((item) => ({ id: item.requestId, label: item.request ?? item.requestId }))} />
        <Select id="adjustmentOutcome" name="outcome" label="Outcome" values={['agreed','refused']} /><Area id="adjustmentReason" name="reason" label="Private decision reason" />
        <Area id="operationalInstruction" name="operationalInstruction" label="Operational instruction (agreed only)" required={false} />
        <Field id="adjustmentEffectiveOn" name="effectiveOn" label="Effective date (agreed only)" type="date" /><Field id="adjustmentReviewOn" name="reviewOn" label="Review date (optional)" type="date" />
        <button className="button" disabled={sending}>Record permanent decision</button></form></details>}
      {!!agreedAdjustments.length && <details><summary>Record or close adjustment progress</summary><form aria-label="Record HR adjustment progress"
        onSubmit={(event) => void send(event, '/api/hr/adjustments/decisions/:id/progress', (form) => ({ action: form.get('action'), note: text(form, 'note') }))}>
        <Choice id="adjustmentDecisionId" name="id" label="Adjustment" items={agreedAdjustments.map((item) => ({ id: item.decisionId!, label: item.operationalInstruction ?? item.requestId }))} />
        <Select id="adjustmentProgress" name="action" label="Progress" values={['implemented','reviewed','closed']} /><Area id="adjustmentProgressNote" name="note" label="Note" />
        <button className="button" disabled={sending}>Record progress</button></form></details>}
    </>}

    {access.canManagePeople && lifecycle && <LifecycleActions personId={personId} engagementId={activeEngagement?.id} lifecycle={lifecycle} sending={sending} send={send} />}
    {access.canManageVetting && vetting && activeEngagement && <VettingActions personId={personId} engagementId={activeEngagement.id}
      files={identityFiles} vetting={vetting} sending={sending} send={send} />}
    {access.canManageCompetence && competence && <CompetenceActions personId={personId} competence={competence} sending={sending} send={send} />}
  </section>;
}

type Sender = (event: FormEvent<HTMLFormElement>, path: `/api/${string}`, body: (form: FormData) => Record<string, unknown>, method?: 'post' | 'put') => Promise<void>;

function LifecycleActions({ personId, engagementId, lifecycle, sending, send }: { personId: string; engagementId?: string;
  lifecycle: HrLifecycle; sending: boolean; send: Sender }) {
  const openItems = lifecycle.checklists.flatMap((list) => list.items.filter((item) => item.state !== 'completed'));
  return <>{engagementId && <details><summary>Create a lifecycle checklist</summary><form aria-label="Create lifecycle checklist"
    onSubmit={(event) => void send(event, `/api/hr/people/${personId}/lifecycle`, (form) => { const kind = String(form.get('kind'));
      const codes = form.getAll('code'); const titles = form.getAll('title'); const owners = form.getAll('ownerKind');
      const required = form.getAll('required'); const dueDates = form.getAll('dueOn'); return {
      engagementId, kind, effectiveOn: String(form.get('effectiveOn')), reasonCategory: kind === 'leaver' ? form.get('reasonCategory') : null,
      items: codes.map((code, index) => ({ code: String(code).trim(), title: String(titles[index] ?? '').trim(), ownerKind: owners[index],
        required: required[index] === 'true', dueOn: String(dueDates[index] ?? '').trim() || null })) }; })}>
    <Select id="lifecycleKind" name="kind" label="Checklist kind" values={['joiner','mover','leaver']} />
    <Select id="leaverReason" name="reasonCategory" label="Leaver reason (leaver only)" values={['resignation','dismissal','redundancy','retirement','end_of_fixed_term','transfer','other']} />
    <Field id="lifecycleEffectiveOn" name="effectiveOn" label="Effective date" type="date" /><ChecklistItems />
    <button className="button" disabled={sending}>Create checklist</button></form></details>}
    {!!openItems.length && <details><summary>Complete a lifecycle item</summary><form aria-label="Complete lifecycle item"
      onSubmit={(event) => void send(event, '/api/hr/lifecycle/items/:id/events', (form) => ({ action: 'completed', note: String(form.get('note') ?? '').trim() }))}>
      <Choice id="lifecycleItemId" name="id" label="Item" items={openItems.map((item) => ({ id: item.id, label: item.title }))} />
      <Area id="lifecycleItemNote" name="note" label="Completion evidence" /><button className="button" disabled={sending}>Complete item</button></form></details>}
    {!!lifecycle.checklists.length && <details><summary>Complete or reopen a checklist</summary><form aria-label="Change lifecycle checklist state"
      onSubmit={(event) => void send(event, '/api/hr/lifecycle/:id/events', (form) => ({ action: form.get('action'), note: String(form.get('note') ?? '').trim() }))}>
      <Choice id="lifecycleChecklistId" name="id" label="Checklist" items={lifecycle.checklists.map((item) => ({ id: item.id, label: `${item.kind}: ${item.state}` }))} />
      <Select id="lifecycleAction" name="action" label="Action" values={['completed','reopened']} /><Area id="lifecycleChecklistNote" name="note" label="Evidence" />
      <button className="button" disabled={sending}>Record checklist event</button></form></details>}
  </>;
}

function VettingActions({ personId, engagementId, files, vetting, sending, send }: { personId: string; engagementId: string;
  files: HrPersonRecord['files']; vetting: HrVetting; sending: boolean; send: Sender }) {
  return <>{!!files.length && <details><summary>Record a right-to-work check</summary><form aria-label="Record right-to-work check"
    onSubmit={(event) => void send(event, `/api/hr/people/${personId}/right-to-work`, (form) => ({ engagementId,
      guidanceVersion: String(form.get('guidanceVersion')), checkRoute: form.get('checkRoute'), checkedOn: form.get('checkedOn'),
      permissionType: form.get('permissionType'), result: form.get('result'), expiresOn: String(form.get('expiresOn') ?? '') || null,
      followUpOn: String(form.get('followUpOn') ?? '') || null, evidenceFileId: form.get('evidenceFileId'),
      identityMatchMethod: String(form.get('identityMatchMethod')), workRestrictions: String(form.get('workRestrictions') ?? '') || null,
      providerReference: String(form.get('providerReference') ?? '') || null }))}>
    <Field id="rtwGuidance" name="guidanceVersion" label="Guidance version" /><Select id="rtwRoute" name="checkRoute" label="Check route" values={['manual','online','digital_provider']} />
    <Field id="rtwCheckedOn" name="checkedOn" label="Checked" type="date" /><Select id="rtwPermission" name="permissionType" label="Permission" values={['british_or_irish','settled','pre_settled','time_limited','other']} />
    <Select id="rtwResult" name="result" label="Result" values={['passed','failed','follow_up_required']} /><Field id="rtwExpiresOn" name="expiresOn" label="Expires (if applicable)" type="date" />
    <Field id="rtwFollowUpOn" name="followUpOn" label="Follow up (if applicable)" type="date" />
    <Choice id="rtwEvidence" name="evidenceFileId" label="Identity evidence" items={files.map((item) => ({ id: item.id, label: item.fileName }))} />
    <Field id="rtwMatchMethod" name="identityMatchMethod" label="Identity match method" /><Area id="rtwRestrictions" name="workRestrictions" label="Work restrictions (optional)" required={false} />
    <Field id="rtwProviderReference" name="providerReference" label="Provider reference (optional)" /><button className="button" disabled={sending}>Record permanent check</button></form></details>}
    <details><summary>Add a qualification or professional record</summary><form aria-label="Add professional record"
      onSubmit={(event) => void send(event, `/api/hr/people/${personId}/professional-records`, (form) => ({ kind: form.get('kind'), title: form.get('title'),
        issuer: form.get('issuer'), validFrom: String(form.get('validFrom') ?? '') || null, validTo: String(form.get('validTo') ?? '') || null,
        identifier: String(form.get('identifier') ?? '') || null, restriction: String(form.get('restriction') ?? '') || null }))}>
      <Select id="professionalKind" name="kind" label="Kind" values={['qualification','professional_registration','practising_certificate']} />
      <Field id="professionalTitle" name="title" label="Title" /><Field id="professionalIssuer" name="issuer" label="Issuer" />
      <Field id="professionalValidFrom" name="validFrom" label="Valid from (optional)" type="date" /><Field id="professionalValidTo" name="validTo" label="Valid to (optional)" type="date" />
      <Field id="professionalIdentifier" name="identifier" label="Identifier (optional)" /><Area id="professionalRestriction" name="restriction" label="Restriction (optional)" required={false} />
      <button className="button" disabled={sending}>Add professional record</button></form></details>
    {!!vetting.professional.length && <details><summary>Record a professional-status check</summary><form aria-label="Record professional status check"
      onSubmit={(event) => void send(event, '/api/hr/professional-records/:id/checks', (form) => ({ status: form.get('status'), checkedOn: form.get('checkedOn'),
        source: form.get('source'), note: String(form.get('note') ?? '') || null }))}>
      <Choice id="professionalRecordId" name="id" label="Record" items={vetting.professional.map((item) => ({ id: item.id, label: item.title }))} />
      <Select id="professionalStatus" name="status" label="Status" values={['current','expired','restricted','suspended','not_verified']} />
      <Field id="professionalCheckedOn" name="checkedOn" label="Checked" type="date" /><Field id="professionalSource" name="source" label="Source" />
      <Area id="professionalNote" name="note" label="Note (optional)" required={false} /><button className="button" disabled={sending}>Record check</button></form></details>}
  </>;
}

function CompetenceActions({ personId, competence, sending, send }: { personId: string; competence: HrCompetence; sending: boolean; send: Sender }) {
  return <><details><summary>Assign required learning</summary><form aria-label="Assign required learning"
    onSubmit={(event) => void send(event, `/api/hr/people/${personId}/learning-assignments`, (form) => ({ title: form.get('title'),
      provider: String(form.get('provider') ?? '') || null, dueOn: form.get('dueOn'), details: form.get('details') }))}>
    <Field id="learningTitle" name="title" label="Title" /><Field id="learningProvider" name="provider" label="Provider (optional)" />
    <Field id="learningDueOn" name="dueOn" label="Due" type="date" /><Area id="learningDetails" name="details" label="Requirements" />
    <button className="button" disabled={sending}>Assign learning</button></form></details>
    <details><summary>Start a development cycle</summary><form aria-label="Start personnel development cycle"
      onSubmit={(event) => void send(event, `/api/hr/people/${personId}/development`, (form) => ({ title: form.get('title'), periodStart: form.get('periodStart'), periodEnd: form.get('periodEnd') }))}>
      <Field id="developmentTitle" name="title" label="Title" /><Field id="developmentPeriodStart" name="periodStart" label="Period starts" type="date" />
      <Field id="developmentPeriodEnd" name="periodEnd" label="Period ends" type="date" /><button className="button" disabled={sending}>Start cycle</button></form></details>
    {!!competence.development.length && <details><summary>Add a development requirement or review</summary><form aria-label="Add personnel development event"
      onSubmit={(event) => void send(event, '/api/hr/development/:id/events', (form) => ({ kind: form.get('kind'), state: null,
        narrative: form.get('narrative'), evidenceReference: String(form.get('evidenceReference') ?? '') || null }))}>
      <Choice id="developmentCycleId" name="id" label="Cycle" items={competence.development.map((item) => ({ id: item.id, label: item.title }))} />
      <Select id="developmentEventKind" name="kind" label="Kind" values={['requirement','review']} /><Area id="developmentNarrative" name="narrative" label="Narrative" />
      <Field id="developmentEvidence" name="evidenceReference" label="Evidence reference (optional)" /><button className="button" disabled={sending}>Record event</button></form></details>}
    <details><summary>Record an objective or appraisal</summary><form aria-label="Record personnel review"
      onSubmit={(event) => void send(event, `/api/hr/people/${personId}/reviews`, (form) => { const kind = String(form.get('kind')); return { kind,
        title: form.get('title'), periodStart: kind === 'appraisal' ? form.get('periodStart') : null, periodEnd: kind === 'appraisal' ? form.get('periodEnd') : null,
        targetOn: kind === 'objective' ? form.get('targetOn') : null, statement: form.get('statement') }; })}>
      <Select id="reviewKind" name="kind" label="Kind" values={['objective','appraisal']} /><Field id="reviewTitle" name="title" label="Title" />
      <Field id="reviewTargetOn" name="targetOn" label="Objective target date" type="date" /><Field id="reviewPeriodStart" name="periodStart" label="Appraisal period starts" type="date" />
      <Field id="reviewPeriodEnd" name="periodEnd" label="Appraisal period ends" type="date" /><Area id="reviewStatement" name="statement" label="Statement" />
      <button className="button" disabled={sending}>Record immutable review</button></form></details>
  </>;
}

function workPattern(form: FormData) { const number = (name: string) => Number(form.get(name)); return { timeZone: String(form.get('timeZone') ?? ''),
  mondayMinutes: number('mondayMinutes'), tuesdayMinutes: number('tuesdayMinutes'), wednesdayMinutes: number('wednesdayMinutes'),
  thursdayMinutes: number('thursdayMinutes'), fridayMinutes: number('fridayMinutes'), saturdayMinutes: number('saturdayMinutes'), sundayMinutes: number('sundayMinutes') }; }
function PatternFields({ prefix }: { prefix: string }) { return <><Field id={`${prefix}TimeZone`} name="timeZone" label="IANA time zone" value="Europe/London" />
  {['monday','tuesday','wednesday','thursday','friday','saturday','sunday'].map((day) => <Field key={day} id={`${prefix}${day}`} name={`${day}Minutes`}
    label={`${day[0]!.toUpperCase()}${day.slice(1)} minutes`} type="number" value={['saturday','sunday'].includes(day) ? '0' : '450'} />)}</>; }
function HolidayPayElements() { const [count, setCount] = useState(1); return <fieldset className="fieldset"><legend>Included payroll components</legend>
  {Array.from({ length: count }, (_, index) => <div key={index} className="line-editor"><Field id={`payElementName${index}`} name="elementName"
    label={`Component ${index + 1} name`} /><Field id={`payElementAmount${index}`} name="elementAmountPence" label={`Component ${index + 1} (pence)`} type="number" /></div>)}
  {count < 20 && <button className="button button-secondary" type="button" onClick={() => setCount((value) => value + 1)}>Add another component</button>}</fieldset>; }
function ChecklistItems() { const [count, setCount] = useState(1); return <fieldset className="fieldset"><legend>Checklist items</legend>
  {Array.from({ length: count }, (_, index) => <div key={index} className="line-editor"><h3>Item {index + 1}</h3><Field id={`lifecycleCode${index}`} name="code" label="Code" />
    <Field id={`lifecycleTitle${index}`} name="title" label="Title" /><Select id={`lifecycleOwner${index}`} name="ownerKind" label="Owner"
      values={['hr','administrator','manager','worker','other_module']} /><Select id={`lifecycleRequired${index}`} name="required" label="Required" values={['true','false']} />
    <Field id={`lifecycleDueOn${index}`} name="dueOn" label="Due (optional)" type="date" /></div>)}
  {count < 50 && <button className="button button-secondary" type="button" onClick={() => setCount((value) => value + 1)}>Add another checklist item</button>}</fieldset>; }
function Choice({ id, name, label, items, empty }: { id: string; name: string; label: string; items: Array<{ id: string; label: string }>; empty?: string }) { return <div className="field">
  <label className="label" htmlFor={id}>{label}</label><select className="select" id={id} name={name} defaultValue={empty ? '' : undefined}>{empty && <option value="">{empty}</option>}
    {items.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></div>; }
function Field({ id, name, label, type = 'text', value }: { id: string; name: string; label: string; type?: string; value?: string | null }) { return <div className="field">
  <label className="label" htmlFor={id}>{label}</label><input className="input" id={id} name={name} type={type} defaultValue={value ?? ''} /></div>; }
function Area({ id, name, label, required = true }: { id: string; name: string; label: string; required?: boolean }) { return <div className="field"><label className="label" htmlFor={id}>{label}</label>
  <textarea className="input" id={id} name={name} rows={4} required={required} minLength={required ? 3 : undefined} /></div>; }
function Select({ id, name, label, values }: { id: string; name: string; label: string; values: string[] }) { return <div className="field"><label className="label" htmlFor={id}>{label}</label>
  <select className="select" id={id} name={name}>{values.map((value) => <option key={value} value={value}>{value.replaceAll('_', ' ')}</option>)}</select></div>; }
