import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { HowTo } from '@/components/how-to';
import { apiGet } from '@/lib/api';
import { CATEGORY_LABELS, formatSize } from '@/lib/documents';
import { formatDate } from '@/lib/format';
import { MATTER_STATUS_LABELS, MATTER_TYPE_LABELS, TEAM_ROLE_LABELS } from '@/lib/matters';
import { portalContentPath, type PortalDocument, type PortalMatter } from '@/lib/portal';

export const metadata: Metadata = { title: 'Matter' };

function CannotSeeMatter() {
  return (
    <>
      <h1>You cannot see this matter</h1>
      <p>Either there is no such matter, or you no longer have access to it.</p>
      <p>
        <Link href="/portal">Back to your matters</Link>
      </p>
    </>
  );
}

export default async function PortalMatterPage({
  params,
  searchParams,
}: {
  params: Promise<{ matterId: string }>;
  searchParams: Promise<{ documentsBefore?: string | string[] }>;
}) {
  const { matterId } = await params;
  const { documentsBefore } = await searchParams;
  const matterResult = await apiGet<PortalMatter>(`/portal/matters/${encodeURIComponent(matterId)}`);
  if (matterResult.status === 401) {
    redirect('/sign-in');
  }
  if (matterResult.status === 403) {
    redirect('/');
  }
  if (matterResult.status === 400) {
    notFound();
  }
  if (matterResult.status === 404) {
    return <CannotSeeMatter />;
  }
  if (!matterResult.body) {
    throw new Error('The client matter could not be loaded');
  }

  const matter = matterResult.body;
  const documentResult = await apiGet<{ documents: PortalDocument[]; next: string | null }>(
    `/portal/matters/${encodeURIComponent(matter.id)}/documents`,
    { before: typeof documentsBefore === 'string' ? documentsBefore : undefined },
  );
  if (documentResult.status === 401) {
    redirect('/sign-in');
  }
  if (documentResult.status === 403) {
    redirect('/');
  }
  if (documentResult.status === 400) {
    redirect(`/portal/matters/${matter.id}`);
  }
  if (documentResult.status === 404) {
    return <CannotSeeMatter />;
  }
  if (!documentResult.body) {
    throw new Error('The shared document list could not be loaded');
  }

  return (
    <>
      <span className="caption">
        {matter.reference} &middot; {MATTER_STATUS_LABELS[matter.status]}
      </span>
      <h1>{matter.title}</h1>
      <HowTo>
        <li>&ldquo;Team&rdquo; shows who at the firm is working on your matter.</li>
        <li>&ldquo;Documents&rdquo; lists the files the firm has shared with you. Select one to download it.</li>
        <li>For questions, contact a person named in the team.</li>
      </HowTo>
      {matter.status === 'closed' && (
        <div className="notice">
          <p>
            <strong>This matter is closed.</strong> Its shared documents remain available to you.
          </p>
        </div>
      )}
      <dl className="summary">
        <div className="summary-row">
          <dt>Type of work</dt>
          <dd>{MATTER_TYPE_LABELS[matter.matterType]}</dd>
        </div>
        <div className="summary-row">
          <dt>Opened</dt>
          <dd>{formatDate(matter.openedAt)}</dd>
        </div>
      </dl>

      <h2>Team</h2>
      <table className="table">
        <thead>
          <tr>
            <th scope="col">Name</th>
            <th scope="col">Role</th>
          </tr>
        </thead>
        <tbody>
          {matter.team.map((member, index) => (
            <tr key={`${member.role}-${index}`}>
              <td>{member.displayName}</td>
              <td>{TEAM_ROLE_LABELS[member.role]}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <section aria-labelledby="documents-heading">
        <h2 id="documents-heading">Documents</h2>
        {documentResult.body.documents.length === 0 ? (
          <p>No documents have been shared with you.</p>
        ) : (
          <table className="table">
            <caption className="secondary">Only documents shared with you appear here. Downloads are recorded.</caption>
            <thead>
              <tr>
                <th scope="col">Title</th>
                <th scope="col">Category</th>
                <th scope="col">Latest file</th>
                <th scope="col">Added</th>
                <th scope="col">
                  <span className="visually-hidden">Download</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {documentResult.body.documents.map((document) => (
                <tr key={document.id}>
                  <td>{document.title}</td>
                  <td>{CATEGORY_LABELS[document.category]}</td>
                  <td>
                    {document.latest.fileName} <span className="secondary">({formatSize(document.latest.sizeBytes)})</span>
                  </td>
                  <td>{formatDate(document.latest.uploadedAt)}</td>
                  <td>
                    <a href={portalContentPath(document.id)} download>
                      Download<span className="visually-hidden"> {document.title}</span>
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {documentResult.body.next && (
          <p>
            <Link href={`/portal/matters/${matter.id}?documentsBefore=${encodeURIComponent(documentResult.body.next)}`}>Older documents</Link>
          </p>
        )}
      </section>
    </>
  );
}
