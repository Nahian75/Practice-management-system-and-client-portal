'use client';

import { useRouter } from 'next/navigation';
import { useRef, useState, type FormEvent } from 'react';
import { ConflictResults } from '@/components/conflict-results';
import { ErrorSummary } from '@/components/error-summary';
import { TextField } from '@/components/fields';
import { MATTER_TYPE_LABELS, PARTY_ROLE_LABELS, type Colleague, type ConflictCheck, type PartyRole } from '@/lib/matters';
import { messagesOf, postJson } from '@/lib/requests';

interface PartyRow {
  key: number;
  role: PartyRole;
  kind: 'individual' | 'organisation';
  name: string;
}

const MAX_PARTIES = 20;

/**
 * Opening a matter in two steps, as the API requires: the other parties are
 * checked for conflicts first, then the matter is opened on that check. The
 * check is kept with the matter; changing the parties means a new check.
 */
export function OpenMatterFlow({
  clientId,
  clientCheckName,
  colleagues,
  accountId,
}: {
  clientId: string;
  /** The client's name as checked, sent when there are no other parties: a check needs at least one name. */
  clientCheckName: string;
  colleagues: Colleague[];
  accountId: string;
}) {
  const router = useRouter();
  const nextKey = useRef(1);
  const [parties, setParties] = useState<PartyRow[]>([{ key: 0, role: 'opponent', kind: 'individual', name: '' }]);
  const [check, setCheck] = useState<{ check: ConflictCheck; parties: PartyRow[] }>();
  const [errors, setErrors] = useState<string[]>();
  const [sending, setSending] = useState(false);

  const change = (key: number, update: Partial<PartyRow>) =>
    setParties((rows) => rows.map((row) => (row.key === key ? { ...row, ...update } : row)));

  async function runCheck(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const named = parties.map((row) => ({ ...row, name: row.name.trim() })).filter((row) => row.name !== '');
    setSending(true);
    setErrors(undefined);
    try {
      const response = await postJson('/api/conflict-checks', {
        clientId,
        names: named.length > 0 ? named.map((row) => row.name) : [clientCheckName],
      });
      if (response.ok) {
        setCheck({ check: (await response.json()) as ConflictCheck, parties: named });
        return;
      }
      setErrors(response.status === 400 ? ['Names can be at most 200 characters'] : await messagesOf(response));
    } finally {
      setSending(false);
    }
  }

  async function open(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!check) {
      return;
    }
    const form = new FormData(event.currentTarget);
    const title = String(form.get('title') ?? '').trim();
    if (title === '') {
      setErrors(['Enter a title for the matter']);
      return;
    }
    setSending(true);
    setErrors(undefined);
    try {
      const response = await postJson('/api/matters', {
        clientId,
        title,
        matterType: String(form.get('matterType')),
        supervisingPartnerId: String(form.get('supervisingPartnerId')),
        feeEarnerIds: form.getAll('feeEarnerIds').map(String),
        conflictCheckId: check.check.id,
        parties: check.parties.map(({ role, kind, name }) => ({ role, kind, name })),
      });
      if (response.ok) {
        router.push(`/matters/${((await response.json()) as { id: string }).id}`);
        return;
      }
      setErrors(await messagesOf(response));
    } finally {
      setSending(false);
    }
  }

  if (!check) {
    return (
      <form onSubmit={runCheck} noValidate>
        <h2>Other parties</h2>
        <p>
          Everyone else involved, such as the other side and their solicitors. They are checked against every client,
          contact and other party of the firm. Leave a name empty if there is no one. The client is always checked.
        </p>
        {errors && <ErrorSummary messages={errors} />}
        {parties.map((row, index) => (
          <fieldset key={row.key} className="fieldset">
            <legend>Other party {index + 1}</legend>
            <div className="field">
              <label className="label" htmlFor={`party-${row.key}-name`}>
                Name
              </label>
              <input
                className="input"
                id={`party-${row.key}-name`}
                value={row.name}
                maxLength={200}
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => change(row.key, { name: event.target.value })}
              />
            </div>
            <div className="field">
              <label className="label" htmlFor={`party-${row.key}-role`}>
                Role
              </label>
              <select
                className="select"
                id={`party-${row.key}-role`}
                value={row.role}
                onChange={(event) => change(row.key, { role: event.target.value as PartyRole })}
              >
                {Object.entries(PARTY_ROLE_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label className="label" htmlFor={`party-${row.key}-kind`}>
                Person or organisation
              </label>
              <select
                className="select"
                id={`party-${row.key}-kind`}
                value={row.kind}
                onChange={(event) => change(row.key, { kind: event.target.value as PartyRow['kind'] })}
              >
                <option value="individual">A person</option>
                <option value="organisation">An organisation</option>
              </select>
            </div>
            {parties.length > 1 && (
              <button
                className="link-button"
                type="button"
                onClick={() => setParties((rows) => rows.filter((other) => other.key !== row.key))}
              >
                Remove<span className="visually-hidden"> other party {index + 1}</span>
              </button>
            )}
          </fieldset>
        ))}
        <div className="actions">
          {parties.length < MAX_PARTIES && (
            <button
              className="button button-secondary"
              type="button"
              onClick={() => setParties((rows) => [...rows, { key: nextKey.current++, role: 'opponent', kind: 'individual', name: '' }])}
            >
              Add another party
            </button>
          )}
          <button className="button" type="submit" disabled={sending}>
            Run conflict check
          </button>
        </div>
        <p className="secondary">Each name checked counts towards your hourly search allowance.</p>
      </form>
    );
  }

  const partners = colleagues.filter((colleague) => colleague.isPartner);
  const others = colleagues.filter((colleague) => colleague.id !== accountId);
  return (
    <>
      <h2>Conflict check</h2>
      <ConflictResults check={check.check} />
      {check.check.matchCount > 0 && (
        <p>
          The matter can still be opened. It will wait for the supervising partner to look at the possible conflicts and
          record why they are not a conflict before any work starts.
        </p>
      )}
      <p>
        <button
          className="link-button"
          type="button"
          onClick={() => {
            setCheck(undefined);
            setErrors(undefined);
          }}
        >
          Change the other parties
        </button>{' '}
        <span className="secondary">(this needs a new check)</span>
      </p>

      <hr className="rule" />
      <form onSubmit={open} noValidate>
        <h2>The matter</h2>
        {errors && <ErrorSummary messages={errors} />}
        <TextField name="title" label="Title" hint="For example Purchase of 12 High Street" />
        <div className="field">
          <label className="label" htmlFor="matterType">
            Type of work
          </label>
          <select className="select" id="matterType" name="matterType" defaultValue="other">
            {Object.entries(MATTER_TYPE_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label className="label" htmlFor="supervisingPartnerId">
            Supervising partner
          </label>
          <select
            className="select"
            id="supervisingPartnerId"
            name="supervisingPartnerId"
            defaultValue={partners.some((partner) => partner.id === accountId) ? accountId : partners[0]?.id}
          >
            {partners.map((partner) => (
              <option key={partner.id} value={partner.id}>
                {partner.displayName}
              </option>
            ))}
          </select>
        </div>
        {others.length > 0 && (
          <fieldset className="fieldset checkbox">
            <legend>Other fee earners (optional)</legend>
            <span className="hint">You join the team yourself.</span>
            {others.map((colleague) => (
              <label key={colleague.id}>
                <input type="checkbox" name="feeEarnerIds" value={colleague.id} />
                {colleague.displayName}
              </label>
            ))}
          </fieldset>
        )}
        <button className="button" type="submit" disabled={sending || partners.length === 0}>
          Open matter
        </button>
      </form>
    </>
  );
}
