import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { NoAccess } from '@/components/no-access';
import { apiGet, currentAccount } from '@/lib/api';
import { CATEGORY_LABELS, contentPath, formatSize, type DocumentDetails } from '@/lib/documents';
import { formatDateTime } from '@/lib/format';
import type { Matter } from '@/lib/matters';
import { NewVersionForm } from './new-version-form';
import { SharingToggle } from './sharing-toggle';
import { WithdrawForm } from './withdraw-form';

export const metadata: Metadata = { title: 'Document' };

export default async function DocumentPage({ params }: { params: Promise<{ documentId: string }> }) {
  const { documentId } = await params;
  const account = await currentAccount();
  if (!account) {
    redirect('/sign-in');
  }
  const { status, body: document } = await apiGet<DocumentDetails>(`/documents/${encodeURIComponent(documentId)}`);
  if (status === 403) {
    return <NoAccess what="documents" />;
  }
  if (status === 400) {
    notFound();
  }
  if (!document) {
    // The same answer for a document that does not exist and one on a matter the person is not on the team of.
    return (
      <>
        <h1>You cannot see this document</h1>
        <p>Either there is no such document, or you are not on its matter&rsquo;s team.</p>
      </>
    );
  }

  const { body: matter } = await apiGet<Matter>(`/matters/${encodeURIComponent(document.matterId)}`);
  const open = matter?.status === 'open';
  const addedBy = document.versions[0]?.uploadedBy.accountId;
  const supervises = matter?.team.some((member) => member.accountId === account.id && member.role === 'supervising_partner') ?? false;
  const withdrawn = document.withdrawal !== null;

  return (
    <>
      {matter && (
        <p>
          <Link href={`/matters/${matter.id}`}>
            Back to {matter.title} ({matter.reference})
          </Link>
        </p>
      )}
      <span className="caption">{CATEGORY_LABELS[document.category]}</span>
      <h1>{document.title}</h1>

      {document.withdrawal && (
        <div className="notice">
          <p>
            <strong>Withdrawn</strong> by {document.withdrawal.withdrawnBy.displayName}, {formatDateTime(document.withdrawal.withdrawnAt)}.
            It is kept, but can no longer be downloaded.
          </p>
          <p>Reason: {document.withdrawal.reason}</p>
        </div>
      )}

      {!withdrawn && (
        <>
          <SharingToggle documentId={document.id} shared={document.sharedWithClient} />
          <hr className="rule" />
        </>
      )}

      <h2>Versions</h2>
      <table className="table">
        <thead>
          <tr>
            <th scope="col">Version</th>
            <th scope="col">File</th>
            <th scope="col">Added by</th>
            <th scope="col">When</th>
            {!withdrawn && (
              <th scope="col">
                <span className="visually-hidden">Download</span>
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {[...document.versions].reverse().map((version) => (
            <tr key={version.number}>
              <td>{version.number}</td>
              <td>
                {version.fileName} <span className="secondary">({formatSize(version.sizeBytes)})</span>
              </td>
              <td>{version.uploadedBy.displayName}</td>
              <td>{formatDateTime(version.uploadedAt)}</td>
              {!withdrawn && (
                <td>
                  <a href={contentPath(document.id, version.number)} download>
                    Download<span className="visually-hidden"> version {version.number}</span>
                  </a>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>

      {!withdrawn && open && (
        <>
          <hr className="rule" />
          <NewVersionForm documentId={document.id} />
          {(addedBy === account.id || supervises) && (
            <>
              <hr className="rule" />
              <WithdrawForm documentId={document.id} />
            </>
          )}
        </>
      )}
    </>
  );
}
