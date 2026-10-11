import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { apiGet } from '@/lib/api';
import type { CddCase } from '@/lib/compliance';
import { formatCalendarDate, formatDateTime } from '@/lib/format';
import { CddCaseActions } from './cdd-case-actions';

export const metadata: Metadata = { title: 'CDD case' };

export default async function CddCasePage({ params }: { params: Promise<{ clientId: string; caseId: string }> }) {
  const { clientId, caseId } = await params;
  const result = await apiGet<CddCase>(`/clients/${encodeURIComponent(clientId)}/cdd/${encodeURIComponent(caseId)}`);
  if (!result.body) notFound();
  const item = result.body;
  const subjectName = (id: string) => String(item.subjects.find((subject) => subject.id === id)?.details.name ?? id);
  const evidenceName = (id: string) => item.evidence.find((evidence) => evidence.id === id)?.fileName ?? id;
  return <>
    <p><Link href={`/clients/${clientId}/compliance`}>Back to client AML record</Link></p>
    <h1>CDD case version {item.version}</h1>
    <p><strong>Status:</strong> {item.status}. <strong>Prepared by:</strong> {item.preparedBy.displayName}. <strong>Created:</strong> {formatDateTime(item.createdAt)}.</p>
    <dl><dt>Intended relationship</dt><dd>{item.intendedRelationship}</dd><dt>Reason for checks</dt><dd>{item.reason}</dd></dl>
    <section aria-labelledby="subjects-heading"><h2 id="subjects-heading">People and entities</h2>
      {!item.subjects.length ? <p>No subjects recorded.</p> : <table className="table"><thead><tr><th scope="col">Name</th><th scope="col">Kind</th><th scope="col">Relationship</th><th scope="col">Recorded</th></tr></thead>
        <tbody>{item.subjects.map((subject) => <tr key={subject.id}><td>{String(subject.details.name ?? 'Unnamed')}</td><td>{subject.kind.replace('_', ' ')}</td><td>{subject.relationship.replaceAll('_', ' ')}</td><td>{formatDateTime(subject.recordedAt)}</td></tr>)}</tbody></table>}
    </section>
    <section aria-labelledby="evidence-heading"><h2 id="evidence-heading">Protected evidence</h2>
      {!item.evidence.length ? <p>No evidence uploaded.</p> : <table className="table"><thead><tr><th scope="col">File</th><th scope="col">Type</th><th scope="col">Expires</th><th scope="col">Uploaded</th></tr></thead>
        <tbody>{item.evidence.map((evidence) => <tr key={evidence.id}><td><a href={`/api/clients/${clientId}/cdd/${caseId}/evidence/${evidence.id}/content`}>{evidence.fileName}</a></td><td>{evidence.evidenceType}</td><td>{evidence.expiresOn ? formatCalendarDate(evidence.expiresOn) : 'Not set'}</td><td>{formatDateTime(evidence.uploadedAt)}</td></tr>)}</tbody></table>}
    </section>
    {!!item.verifications.length && <section aria-labelledby="verification-heading"><h2 id="verification-heading">Verification results</h2><table className="table"><thead><tr><th scope="col">Subject</th><th scope="col">Evidence</th><th scope="col">Method</th><th scope="col">Outcome</th><th scope="col">Checked</th></tr></thead><tbody>{item.verifications.map((record) => <tr key={record.id}><td>{subjectName(record.subjectId)}</td><td>{evidenceName(record.evidenceId)}</td><td>{record.method.replace('_', ' ')}</td><td>{record.outcome.replace('_', ' ')}</td><td>{formatCalendarDate(record.checkedOn)}</td></tr>)}</tbody></table></section>}
    {!!item.ownership.length && <section aria-labelledby="ownership-heading"><h2 id="ownership-heading">Ownership and control</h2><ul>{item.ownership.map((record) => <li key={record.id}>{subjectName(record.controllerSubjectId)} controls {subjectName(record.ownedSubjectId)}{record.ownershipPercent ? ` (${record.ownershipPercent}%)` : ''}: {record.details}</li>)}</ul></section>}
    {!!item.authorities.length && <section aria-labelledby="authority-heading"><h2 id="authority-heading">Authority to act</h2><ul>{item.authorities.map((record) => <li key={record.id}>{subjectName(record.representativeSubjectId)} represents {subjectName(record.representedSubjectId)}: {record.authorityType}; verified {formatCalendarDate(record.verifiedOn)}</li>)}</ul></section>}
    {item.abandonment && <p className="notice"><strong>Abandoned:</strong> {item.abandonment.reason}</p>}
    {item.status === 'draft' && <CddCaseActions clientId={clientId} caseId={caseId} subjects={item.subjects} evidence={item.evidence} />}
  </>;
}
