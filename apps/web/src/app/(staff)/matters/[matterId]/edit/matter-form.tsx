'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { ErrorSummary } from '@/components/error-summary';
import { TextField } from '@/components/fields';
import { MATTER_TYPE_LABELS, type Matter } from '@/lib/matters';
import { messagesOf } from '@/lib/requests';

/** Changing a matter's title or type of work, for anyone on its team while it is not closed. */
export function MatterForm({ matter }: { matter: Matter }) {
  const router = useRouter();
  const [errors, setErrors] = useState<string[]>();
  const [sending, setSending] = useState(false);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const title = String(form.get('title') ?? '').trim();
    if (title === '') {
      setErrors(['Enter a title for the matter']);
      return;
    }
    setSending(true);
    setErrors(undefined);
    try {
      const response = await fetch(`/api/matters/${encodeURIComponent(matter.id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, matterType: String(form.get('matterType')) }),
      });
      if (response.ok) {
        router.push(`/matters/${matter.id}`);
        router.refresh();
        return;
      }
      setErrors(await messagesOf(response));
    } finally {
      setSending(false);
    }
  }

  return (
    <form onSubmit={save} noValidate>
      {errors && <ErrorSummary messages={errors} />}
      <TextField name="title" label="Title" defaultValue={matter.title} />
      <div className="field">
        <label className="label" htmlFor="matterType">
          Type of work
        </label>
        <select className="select" id="matterType" name="matterType" defaultValue={matter.matterType}>
          {Object.entries(MATTER_TYPE_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </div>
      <button className="button" type="submit" disabled={sending}>
        Save changes
      </button>
    </form>
  );
}
