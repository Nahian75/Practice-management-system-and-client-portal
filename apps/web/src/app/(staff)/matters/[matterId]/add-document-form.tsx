'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { DocumentFileField, sendDocument } from '@/components/document-file';
import { ErrorSummary } from '@/components/error-summary';
import { TextField } from '@/components/fields';
import { CATEGORY_LABELS } from '@/lib/documents';

/** Adding a document to an open matter: a title, a category and the file. */
export function AddDocumentForm({ matterId }: { matterId: string }) {
  const router = useRouter();
  const [errors, setErrors] = useState<string[]>();
  const [added, setAdded] = useState<string>();
  const [sending, setSending] = useState(false);

  async function add(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const title = String(form.get('title') ?? '').trim();
    if (title === '') {
      setErrors(['Enter a title for the document']);
      return;
    }
    setSending(true);
    setErrors(undefined);
    setAdded(undefined);
    try {
      const problems = await sendDocument(`/api/matters/${encodeURIComponent(matterId)}/documents`, form, ['title', 'category']);
      if (problems) {
        setErrors(problems);
        return;
      }
      formElement.reset();
      setAdded(title);
      router.refresh();
    } finally {
      setSending(false);
    }
  }

  return (
    <form onSubmit={add} noValidate>
      <h3>Add a document</h3>
      {errors && <ErrorSummary messages={errors} />}
      <div role="status">{added && <p className="notice">Added “{added}”.</p>}</div>
      <TextField name="title" label="Title" hint="For example: Signed lease" />
      <div className="field">
        <label className="label" htmlFor="category">
          Category
        </label>
        <select className="select" id="category" name="category" defaultValue="correspondence">
          {Object.entries(CATEGORY_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </div>
      <DocumentFileField />
      <button className="button" type="submit" disabled={sending}>
        {sending ? 'Checking and adding…' : 'Add document'}
      </button>
    </form>
  );
}
