'use client';

import { ACCEPTED_DESCRIPTION, ACCEPTED_FILES, MAX_DOCUMENT_BYTES } from '@/lib/documents';
import { messagesOf } from '@/lib/requests';

/** The file picker for a document, with what is accepted said up front. */
export function DocumentFileField() {
  return (
    <div className="field">
      <label className="label" htmlFor="file">
        File
      </label>
      <span className="hint" id="file-hint">
        {ACCEPTED_DESCRIPTION}. Every file is checked for viruses.
      </span>
      <input className="input" id="file" name="file" type="file" accept={ACCEPTED_FILES} aria-describedby="file-hint" />
    </div>
  );
}

/**
 * Sends a document to the API: the text fields first, then the file, as the
 * API reads them. A file that is missing or over 50 MB is refused here, so
 * nobody waits for an upload that would be refused; the API checks
 * everything again. Returns the problems to show, or none.
 */
export async function sendDocument(path: `/api/${string}`, form: FormData, fieldNames: readonly string[]): Promise<string[] | undefined> {
  const file = form.get('file');
  if (!(file instanceof File) || file.size === 0) {
    return ['Choose a file'];
  }
  if (file.size > MAX_DOCUMENT_BYTES) {
    return ['The file is over 50 MB'];
  }
  const body = new FormData();
  for (const name of fieldNames) {
    body.append(name, String(form.get(name) ?? '').trim());
  }
  body.append('file', file, file.name);

  const response = await fetch(path, { method: 'POST', body });
  return response.ok ? undefined : messagesOf(response);
}
