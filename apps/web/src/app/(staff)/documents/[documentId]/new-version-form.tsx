'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { DocumentFileField, sendDocument } from '@/components/document-file';
import { ErrorSummary } from '@/components/error-summary';

/** A new version of the document. Earlier versions are kept, and stay downloadable. */
export function NewVersionForm({ documentId }: { documentId: string }) {
  const router = useRouter();
  const [errors, setErrors] = useState<string[]>();
  const [sending, setSending] = useState(false);

  async function add(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    setSending(true);
    setErrors(undefined);
    try {
      const problems = await sendDocument(`/api/documents/${encodeURIComponent(documentId)}/versions`, new FormData(formElement), []);
      if (problems) {
        setErrors(problems);
        return;
      }
      formElement.reset();
      router.refresh();
    } finally {
      setSending(false);
    }
  }

  return (
    <form onSubmit={add} noValidate>
      <h2>Add a new version</h2>
      {errors && <ErrorSummary messages={errors} />}
      <DocumentFileField />
      <button className="button" type="submit" disabled={sending}>
        {sending ? 'Checking and adding…' : 'Add version'}
      </button>
    </form>
  );
}
