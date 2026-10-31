'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { ErrorSummary } from '@/components/error-summary';
import { DateFields, dateFrom } from '@/components/fields';
import { messagesOf, postJson } from '@/lib/requests';

export function TimeEntryForm({ matterId,initialMinutes,timer }: { matterId: string;initialMinutes?:number;timer?:{timerId:string;revision:string} }) {
  const router = useRouter();
  const [errors, setErrors] = useState<string[]>();
  const [saved, setSaved] = useState(false);
  const [sending, setSending] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const workedOn = dateFrom(form, 'workedOn');
    const minutes = Number(String(form.get('minutes') ?? ''));
    const description = String(form.get('timeDescription') ?? '').trim();
    const problems = [
      ...(!workedOn ? ['Enter the work date'] : []),
      ...(!Number.isInteger(minutes) || minutes < 1 || minutes > 1440 ? ['Minutes must be a whole number from 1 to 1440'] : []),
      ...(!description ? ['Enter a description of the work'] : []),
    ];
    if (problems.length) { setErrors(problems); return; }
    setSending(true); setErrors(undefined); setSaved(false);
    try {
      const response = timer
        ? await postJson('/api/workspace/timer/record', {...timer,matterId,workedOn,minutes,description})
        : await postJson(`/api/matters/${encodeURIComponent(matterId)}/time-entries`, { workedOn, minutes, description });
      if (!response.ok) { setErrors(response.status === 400 ? ['Check the time entry details'] : await messagesOf(response)); return; }
      await response.json(); formElement.reset(); setSaved(true); if(timer)window.dispatchEvent(new Event('stass-time-recorded')); router.refresh();
    } catch { setErrors([timer?'Could not confirm the save. Retry the same details to check the result.':'Could not confirm the save. Check the matter time entries before trying again.']); }
    finally { setSending(false); }
  }

  return (
    <form onSubmit={submit} noValidate aria-labelledby="record-time-heading">
      <h3 id="record-time-heading">Record time</h3>
      {timer && <p className="secondary">Review the rounded timer minutes. Saving consumes this paused timer once; retrying the same details will not duplicate it.</p>}
      {errors && <ErrorSummary messages={errors} />}
      {saved && <p className="notice" role="status">Time recorded.</p>}
      <DateFields name="workedOn" legend="Work date" hint="For example 9 10 2026" />
      <div className="field">
        <label className="label" htmlFor="minutes">Minutes</label>
        <input className="input input-short" id="minutes" name="minutes" inputMode="numeric" defaultValue={initialMinutes} />
      </div>
      <div className="field">
        <label className="label" htmlFor="timeDescription">Work description</label>
        <textarea className="input" id="timeDescription" name="timeDescription" rows={3} maxLength={1000} />
      </div>
      <button className="button" type="submit" disabled={sending||(!!timer&&saved)}>{sending ? 'Recording…' : 'Record time'}</button>
    </form>
  );
}
