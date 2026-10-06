import Link from 'next/link';
import { formatDate } from '@/lib/format';
import { CATEGORY_LABELS, contentPath, formatSize, type DocumentSummary } from '@/lib/documents';
import { AddDocumentForm } from './add-document-form';

/** The matter's documents, newest first, and the form to add one while the matter is open. */
export function DocumentsSection({
  matterId,
  documents,
  next,
  canAdd,
}: {
  matterId: string;
  documents: DocumentSummary[] | undefined;
  next: string | null;
  canAdd: boolean;
}) {
  return (
    <section aria-labelledby="documents-heading">
      <h2 id="documents-heading">Documents</h2>
      {documents === undefined ? (
        <p>The documents could not be loaded. Reload the page to try again.</p>
      ) : documents.length === 0 ? (
        <p>No documents yet.</p>
      ) : (
        <table className="table">
          <caption className="secondary">Newest first. Downloads are recorded.</caption>
          <thead>
            <tr>
              <th scope="col">Title</th>
              <th scope="col">Category</th>
              <th scope="col">Latest version</th>
              <th scope="col">Added</th>
              <th scope="col">
                <span className="visually-hidden">Download</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {documents.map((document) => (
              <tr key={document.id}>
                <td>
                  <Link href={`/documents/${document.id}`}>{document.title}</Link>
                </td>
                <td>{CATEGORY_LABELS[document.category]}</td>
                <td>
                  {document.latest.fileName}
                  <span className="secondary">
                    {' '}
                    (version {document.latest.number}, {formatSize(document.latest.sizeBytes)})
                  </span>
                </td>
                <td>{formatDate(document.latest.uploadedAt)}</td>
                <td>
                  <a href={contentPath(document.id, document.latest.number)} download>
                    Download<span className="visually-hidden"> {document.title}</span>
                  </a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {next && (
        <p>
          <Link href={`/matters/${matterId}?documentsBefore=${encodeURIComponent(next)}`}>Older documents</Link>
        </p>
      )}
      {canAdd && <AddDocumentForm matterId={matterId} />}
    </section>
  );
}
