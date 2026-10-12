import { formatCalendarDate, formatDateTime } from '@/lib/format';
import type { HrAdjustments, HrCompetence, HrHealthRecord, HrLeaveRecord, HrLifecycle,
  HrPersonRecord, HrPersonSummary, HrVetting } from '@/lib/hr';

export function EmploymentSummary({ person }: { person: HrPersonSummary }) {
  return <dl className="summary">
    <dt>Work email</dt><dd>{person.workEmail}</dd>
    <dt>Job title</dt><dd>{person.jobTitle ?? 'Not recorded'}</dd>
    <dt>Team</dt><dd>{person.team ?? 'Not recorded'}</dd>
    <dt>Work location</dt><dd>{person.workLocation ?? 'Not recorded'}</dd>
    <dt>Engagement</dt><dd>{person.engagementKind?.replaceAll('_', ' ') ?? 'Not recorded'}</dd>
    <dt>Started</dt><dd>{person.startedOn ? formatCalendarDate(person.startedOn) : 'Not recorded'}</dd>
    <dt>Manager</dt><dd>{person.manager?.displayName ?? 'Not assigned'}</dd>
  </dl>;
}

export function PrivateRecord({ person }: { person: HrPersonRecord }) {
  return <section aria-labelledby="personal-heading"><h2 id="personal-heading">Personal details</h2>
    <dl className="summary"><dt>Personal email</dt><dd>{person.contact.personalEmail ?? 'Not recorded'}</dd>
      <dt>Phone</dt><dd>{person.contact.phone ?? 'Not recorded'}</dd>
      <dt>Home address</dt><dd>{person.contact.address ? [person.contact.address.line1, person.contact.address.line2,
        person.contact.address.town, person.contact.address.postcode, person.contact.address.country].filter(Boolean).join(', ') : 'Not recorded'}</dd>
      <dt>Emergency contact</dt><dd>{person.contact.emergencyContact
        ? `${person.contact.emergencyContact.name} (${person.contact.emergencyContact.relationship}), ${person.contact.emergencyContact.phone}` : 'Not recorded'}</dd>
      <dt>Date of birth</dt><dd>{person.privateDetails.dateOfBirth ? formatCalendarDate(person.privateDetails.dateOfBirth) : 'Not recorded'}</dd></dl>
    {!!person.files.length && <><h3>Files</h3><ul>{person.files.map((file) => <li key={file.id}>
      <a href={`/api/hr/people/${person.personId}/files/${file.id}/content`}>{file.fileName}</a>
      {' '}({file.category.replaceAll('_', ' ')}, {file.workerVisible ? 'worker visible' : 'HR only'})
    </li>)}</ul></>}
    {!!person.corrections.length && <><h3>Correction requests</h3><ul>{person.corrections.map((item) =>
      <li key={item.id}><strong>{item.category}</strong>: {item.request} — {item.outcome ?? 'awaiting HR'}
        {item.response && <>. {item.response}</>}</li>)}</ul></>}
  </section>;
}

export function LeaveRecord({ record }: { record: HrLeaveRecord }) {
  return <section aria-labelledby="leave-heading"><h2 id="leave-heading">Leave and sickness</h2>
    <p><strong>Current balance:</strong> {minutes(record.balanceMinutes)}</p>
    {!record.requests.length ? <p>No leave requests.</p> : <table className="table"><thead><tr><th scope="col">Dates</th>
      <th scope="col">Kind</th><th scope="col">State</th><th scope="col">Reason</th></tr></thead><tbody>
      {record.requests.map((item) => <tr key={item.id}><td>{formatCalendarDate(item.startsOn)} to {formatCalendarDate(item.endsOn)}</td>
        <td>{item.kind}</td><td>{item.state}</td><td>{item.reason}</td></tr>)}</tbody></table>}
    {!!record.sickness.length && <><h3>Sickness administration</h3><table className="table"><thead><tr>
      <th scope="col">Dates</th><th scope="col">Fitness</th><th scope="col">Notified</th></tr></thead><tbody>
      {record.sickness.map((item) => <tr key={item.id}><td>{formatCalendarDate(item.startedOn)}{item.endedOn ? ` to ${formatCalendarDate(item.endedOn)}` : ' onward'}</td>
        <td>{item.fitnessStatus.replaceAll('_', ' ')}</td><td>{formatDateTime(item.notifiedAt)}</td></tr>)}</tbody></table></>}
  </section>;
}

export function HealthRecord({ health, adjustments }: { health?: HrHealthRecord; adjustments: HrAdjustments }) {
  return <section aria-labelledby="adjustments-heading"><h2 id="adjustments-heading">Health and adjustments</h2>
    {health && <>{!health.records.length ? <p>No health evidence recorded.</p> : <ul>{health.records.map((item) =>
      <li key={item.id}><strong>{item.kind.replaceAll('_', ' ')}</strong>: {String(item.details)}</li>)}</ul>}</>}
    {!adjustments.adjustments.length ? <p>No adjustment requests.</p> : <ul>{adjustments.adjustments.map((item) =>
      <li key={item.requestId}>{item.request && <>{item.request}. </>}{item.outcome ?? 'Awaiting decision'}
        {item.operationalInstruction && <> — {item.operationalInstruction}</>}</li>)}</ul>}
  </section>;
}

export function LifecycleRecord({ record }: { record: HrLifecycle }) {
  return <section aria-labelledby="lifecycle-heading"><h2 id="lifecycle-heading">Joiners, movers and leavers</h2>
    {!record.checklists.length ? <p>No lifecycle checklist.</p> : record.checklists.map((list) => <details key={list.id}>
      <summary>{list.kind} — {list.state} ({formatCalendarDate(list.effectiveOn)})</summary><ul>
        {list.items.map((item) => <li key={item.id}>{item.title}: {item.state}{item.dueOn ? `; due ${formatCalendarDate(item.dueOn)}` : ''}</li>)}</ul>
    </details>)}
  </section>;
}

export function VettingRecord({ record }: { record: HrVetting }) {
  return <section aria-labelledby="vetting-heading"><h2 id="vetting-heading">Right to work and professional status</h2>
    {!record.rightToWork.length ? <p>No right-to-work status recorded.</p> : <ul>{record.rightToWork.map((item) =>
      <li key={item.id}>Version {item.version}: {item.result?.replaceAll('_', ' ') ?? 'status unavailable'}
        {item.expiresOn ? `; expires ${formatCalendarDate(item.expiresOn)}` : ''}{item.actionRequired ? '; action required' : ''}</li>)}</ul>}
    {!!record.professional.length && <ul>{record.professional.map((item) => <li key={item.id}>
      <strong>{item.title}</strong>, {item.issuer}: {item.status?.replaceAll('_', ' ') ?? 'not checked'}</li>)}</ul>}
  </section>;
}

export function CompetenceRecord({ record }: { record: HrCompetence }) {
  return <section aria-labelledby="competence-heading"><h2 id="competence-heading">Development, learning and reviews</h2>
    {!record.development.length ? <p>No development cycle.</p> : <ul>{record.development.map((item) =>
      <li key={item.id}><strong>{item.title}</strong>, {formatCalendarDate(item.periodStart)} to {formatCalendarDate(item.periodEnd)}
        {item.events.length ? ` — ${item.events.length} recorded event${item.events.length === 1 ? '' : 's'}` : ''}</li>)}</ul>}
    {!!record.learning.length && <><h3>Required learning</h3><ul>{record.learning.map((item) => <li key={item.id}>
      {item.title}; due {formatCalendarDate(item.dueOn)} — {item.events.at(-1)?.action ?? 'assigned'}</li>)}</ul></>}
    {!!record.reviews.length && <><h3>Objectives and appraisals</h3><ul>{record.reviews.map((item) =>
      <li key={item.id}><strong>{item.title}</strong>: {item.statement}</li>)}</ul></>}
    {!!record.amlTraining.length && <><h3>AML training status</h3><ul>{record.amlTraining.map((item) =>
      <li key={item.materialId}>{item.title} version {item.version}: {item.status}; due {formatCalendarDate(item.dueOn)}</li>)}</ul></>}
  </section>;
}

function minutes(value: number) {
  const sign = value < 0 ? '−' : '';
  const absolute = Math.abs(value);
  return `${sign}${Math.floor(absolute / 60)}h ${absolute % 60}m`;
}
