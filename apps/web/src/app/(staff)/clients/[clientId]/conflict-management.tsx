'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { ErrorSummary } from '@/components/error-summary';
import type {
  ClientConflictCheck,
  ConflictAlias,
  ConflictConnectedPerson,
  ConflictDecision,
} from '@/lib/onboarding';
import { formatDate } from '@/lib/format';
import { RELATION_LABELS } from '@/lib/matters';
import { messagesOf, postJson } from '@/lib/requests';

const ALIAS_KIND_LABELS: Record<string, string> = {
  alias: 'Alias',
  former_name: 'Former name',
  trading_name: 'Trading name',
};

const RELATIONSHIP_LABELS: Record<string, string> = {
  director: 'Director',
  shareholder: 'Shareholder',
  beneficial_owner: 'Beneficial owner',
  connected_person: 'Connected person',
  counterparty: 'Counterparty',
  officer: 'Officer',
  guarantor: 'Guarantor',
};

const OUTCOME_LABELS: Record<string, string> = {
  clear: 'Clear',
  potential: 'Potential conflict',
  escalated: 'Escalated to Compliance',
  approved_with_controls: 'Approved with controls',
  cannot_act: 'Cannot act',
};

export function ConflictManagement({
  clientId,
  aliases,
  connectedPersons,
  checks,
  decisions,
}: {
  clientId: string;
  aliases: ConflictAlias[];
  connectedPersons: ConflictConnectedPerson[];
  checks: ClientConflictCheck[];
  decisions: ConflictDecision[];
}) {
  const router = useRouter();
  const [openAliasForm, setOpenAliasForm] = useState(false);
  const [openConnectedForm, setOpenConnectedForm] = useState(false);
  const [openCheckForm, setOpenCheckForm] = useState(false);
  const [activeDecisionCheckId, setActiveDecisionCheckId] = useState<string | null>(null);

  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<string[]>();
  const [statusMsg, setStatusMsg] = useState<string>();

  async function handleAddAlias(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setSaving(true);
    setErrors(undefined);
    setStatusMsg(undefined);

    try {
      const res = await postJson(`/api/clients/${clientId}/conflict-aliases`, {
        name: String(form.get('name') ?? '').trim(),
        kind: form.get('kind'),
        notes: String(form.get('notes') ?? '').trim() || null,
      });
      if (!res.ok) {
        setErrors(await messagesOf(res));
        return;
      }
      setStatusMsg('Alias recorded successfully.');
      setOpenAliasForm(false);
      router.refresh();
    } catch {
      setErrors(['Failed to record alias']);
    } finally {
      setSaving(false);
    }
  }

  async function handleAddConnectedPerson(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setSaving(true);
    setErrors(undefined);
    setStatusMsg(undefined);

    try {
      const res = await postJson(`/api/clients/${clientId}/conflict-connected-persons`, {
        name: String(form.get('name') ?? '').trim(),
        relationship: form.get('relationship'),
        companyName: String(form.get('companyName') ?? '').trim() || null,
        notes: String(form.get('notes') ?? '').trim() || null,
      });
      if (!res.ok) {
        setErrors(await messagesOf(res));
        return;
      }
      setStatusMsg('Connected person / counterparty recorded successfully.');
      setOpenConnectedForm(false);
      router.refresh();
    } catch {
      setErrors(['Failed to record connected person']);
    } finally {
      setSaving(false);
    }
  }

  async function handleRunCheck(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setSaving(true);
    setErrors(undefined);
    setStatusMsg(undefined);

    const rawNames = String(form.get('names') ?? '')
      .split(/[\n,]/)
      .map((s) => s.trim())
      .filter(Boolean);

    if (rawNames.length === 0) {
      setErrors(['Enter at least one name to check']);
      setSaving(false);
      return;
    }

    try {
      const res = await postJson('/api/conflict-checks', {
        clientId,
        names: rawNames,
      });
      if (!res.ok) {
        setErrors(await messagesOf(res));
        return;
      }
      setStatusMsg('Conflict search completed successfully.');
      setOpenCheckForm(false);
      router.refresh();
    } catch {
      setErrors(['Failed to run conflict check']);
    } finally {
      setSaving(false);
    }
  }

  async function handleRecordDecision(e: FormEvent<HTMLFormElement>, checkId: string) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setSaving(true);
    setErrors(undefined);
    setStatusMsg(undefined);

    const rawSafeguards = String(form.get('safeguards') ?? '')
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);

    try {
      const res = await postJson(`/api/clients/${clientId}/conflict-checks/${checkId}/decisions`, {
        outcome: form.get('outcome'),
        rationale: String(form.get('rationale') ?? '').trim(),
        safeguards: rawSafeguards,
      });
      if (!res.ok) {
        setErrors(await messagesOf(res));
        return;
      }
      setStatusMsg('Conflict decision and safeguards recorded.');
      setActiveDecisionCheckId(null);
      router.refresh();
    } catch {
      setErrors(['Failed to record conflict decision']);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section aria-labelledby="conflict-heading" className="panel">
      <h2 id="conflict-heading">Conflict search and wider subjects</h2>
      <p>
        Conflict checks search clients, former clients, contacts, counterparties, connected persons,
        companies and recorded aliases. All non-clear results require recorded rationale and safeguards.
      </p>

      {statusMsg && <p className="status status-success" role="status">{statusMsg}</p>}
      {errors && <ErrorSummary messages={errors} />}

      {/* Aliases Section */}
      <div className="mt-6">
        <div className="flex justify-between items-center">
          <h3>Client aliases and trading names</h3>
          <button
            type="button"
            className="button secondary"
            onClick={() => setOpenAliasForm(!openAliasForm)}
          >
            {openAliasForm ? 'Cancel' : 'Add alias / former name'}
          </button>
        </div>

        {openAliasForm && (
          <form onSubmit={handleAddAlias} className="form-card mt-4" >
            <div className="field">
              <label htmlFor="alias-name">Name</label>
              <input id="alias-name" name="name" type="text" required maxLength={200} />
            </div>
            <div className="field">
              <label htmlFor="alias-kind">Kind</label>
              <select id="alias-kind" name="kind" defaultValue="alias">
                <option value="alias">Alias</option>
                <option value="former_name">Former name (e.g. maiden name)</option>
                <option value="trading_name">Trading name</option>
              </select>
            </div>
            <div className="field">
              <label htmlFor="alias-notes">Notes (optional)</label>
              <input id="alias-notes" name="notes" type="text" maxLength={1000} />
            </div>
            <button type="submit" disabled={saving} className="button primary">
              {saving ? 'Saving…' : 'Record alias'}
            </button>
          </form>
        )}

        {aliases.length === 0 ? (
          <p className="secondary">No aliases recorded.</p>
        ) : (
          <table className="table mt-2" >
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Kind</th>
                <th scope="col">Notes</th>
                <th scope="col">Added by</th>
                <th scope="col">Added</th>
              </tr>
            </thead>
            <tbody>
              {aliases.map((a) => (
                <tr key={a.id}>
                  <td><strong>{a.name}</strong></td>
                  <td>{ALIAS_KIND_LABELS[a.kind] ?? a.kind}</td>
                  <td>{a.notes ?? '—'}</td>
                  <td>{a.createdBy.displayName}</td>
                  <td>{formatDate(a.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Connected Persons & Counterparties */}
      <div className="mt-8">
        <div className="flex justify-between items-center">
          <h3>Connected persons and counterparties</h3>
          <button
            type="button"
            className="button secondary"
            onClick={() => setOpenConnectedForm(!openConnectedForm)}
          >
            {openConnectedForm ? 'Cancel' : 'Add connected person'}
          </button>
        </div>

        {openConnectedForm && (
          <form onSubmit={handleAddConnectedPerson} className="form-card mt-4" >
            <div className="field">
              <label htmlFor="cp-name">Full name</label>
              <input id="cp-name" name="name" type="text" required maxLength={200} />
            </div>
            <div className="field">
              <label htmlFor="cp-rel">Relationship</label>
              <select id="cp-rel" name="relationship" defaultValue="connected_person">
                <option value="director">Director</option>
                <option value="shareholder">Shareholder</option>
                <option value="beneficial_owner">Beneficial owner</option>
                <option value="connected_person">Connected person</option>
                <option value="counterparty">Counterparty</option>
                <option value="officer">Officer</option>
                <option value="guarantor">Guarantor</option>
              </select>
            </div>
            <div className="field">
              <label htmlFor="cp-company">Company (optional)</label>
              <input id="cp-company" name="companyName" type="text" maxLength={200} />
            </div>
            <div className="field">
              <label htmlFor="cp-notes">Notes (optional)</label>
              <input id="cp-notes" name="notes" type="text" maxLength={1000} />
            </div>
            <button type="submit" disabled={saving} className="button primary">
              {saving ? 'Saving…' : 'Record connected person'}
            </button>
          </form>
        )}

        {connectedPersons.length === 0 ? (
          <p className="secondary">No connected persons or counterparties recorded.</p>
        ) : (
          <table className="table mt-2" >
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Relationship</th>
                <th scope="col">Company</th>
                <th scope="col">Notes</th>
                <th scope="col">Added by</th>
              </tr>
            </thead>
            <tbody>
              {connectedPersons.map((cp) => (
                <tr key={cp.id}>
                  <td><strong>{cp.name}</strong></td>
                  <td>{RELATIONSHIP_LABELS[cp.relationship] ?? cp.relationship}</td>
                  <td>{cp.companyName ?? '—'}</td>
                  <td>{cp.notes ?? '—'}</td>
                  <td>{cp.createdBy.displayName}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Conflict Checks & Decisions */}
      <div className="mt-8">
        <div className="flex justify-between items-center">
          <h3>Conflict search records</h3>
          <button
            type="button"
            className="button secondary"
            onClick={() => setOpenCheckForm(!openCheckForm)}
          >
            {openCheckForm ? 'Cancel' : 'Run conflict check'}
          </button>
        </div>

        {openCheckForm && (
          <form onSubmit={handleRunCheck} className="form-card mt-4" >
            <div className="field">
              <label htmlFor="check-names">Names to check (one per line or comma separated)</label>
              <textarea
                id="check-names"
                name="names"
                rows={3}
                required
                placeholder="e.g. John Doe, Acme Corp"
              />
            </div>
            <button type="submit" disabled={saving} className="button primary">
              {saving ? 'Searching…' : 'Execute search'}
            </button>
          </form>
        )}

        {checks.length === 0 ? (
          <p className="secondary">No conflict checks run for this client.</p>
        ) : (
          <div className="mt-4 flex flex-col gap-4">
            {checks.map((check) => {
              const checkDecisions = decisions.filter((d) => d.checkId === check.id);
              const latestDecision = checkDecisions[0];
              const isClear = check.matchCount === 0;

              return (
                <div key={check.id} className="card p-4 border border-slate-300" >
                  <div className="flex justify-between items-start">
                    <div>
                      <strong>Search run on {formatDate(check.createdAt)}</strong> by {check.requestedBy.displayName}
                      <p className="secondary my-2 mx-0" >
                        Names checked: {check.names.join(', ')}
                      </p>
                    </div>
                    <div>
                      {isClear ? (
                        <span className="badge badge-success">Clear (0 matches)</span>
                      ) : latestDecision ? (
                        <span
                          className={`badge ${
                            latestDecision.outcome === 'approved_with_controls'
                              ? 'badge-success'
                              : latestDecision.outcome === 'cannot_act' || latestDecision.outcome === 'escalated'
                              ? 'badge-danger'
                              : 'badge-warning'
                          }`}
                        >
                          {OUTCOME_LABELS[latestDecision.outcome] ?? latestDecision.outcome}
                        </span>
                      ) : (
                        <span className="badge badge-warning">
                          {check.matchCount} potential {check.matchCount === 1 ? 'match' : 'matches'}
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Matches Table */}
                  {check.matches.length > 0 && (
                    <div className="mt-4">
                      <table className="table">
                        <thead>
                          <tr>
                            <th scope="col">Checked name</th>
                            <th scope="col">Matched name</th>
                            <th scope="col">Relation</th>
                            <th scope="col">Match score</th>
                          </tr>
                        </thead>
                        <tbody>
                          {check.matches.map((m, idx) => (
                            <tr key={idx}>
                              <td>{m.checkedName}</td>
                              <td><strong>{m.matchedName}</strong></td>
                              <td>
                                {(RELATION_LABELS as Record<string, string>)[m.relation] ?? m.relation}
                              </td>
                              <td>{Math.round(m.score * 100)}%</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}

                  {/* Decision info or form */}
                  {latestDecision && (
                    <div
                      className="mt-4 p-4 bg-slate-100 rounded"
                    >
                      <p className="m-0">
                        <strong>Decision by {latestDecision.decidedBy.displayName} on {formatDate(latestDecision.decidedAt)}:</strong>{' '}
                        {latestDecision.rationale}
                      </p>
                      {latestDecision.safeguards.length > 0 && (
                        <div className="mt-2">
                          <span className="secondary">Safeguards established:</span>
                          <ul className="mt-2 mr-0 mb-0 ml-4 p-0">
                            {latestDecision.safeguards.map((sg, i) => (
                              <li key={i}>{sg}</li>
                            ))}
                          </ul>
                        </div>
                      )}
                    </div>
                  )}

                  {!isClear && (
                    <div className="mt-4">
                      {activeDecisionCheckId === check.id ? (
                        <form
                          onSubmit={(e) => handleRecordDecision(e, check.id)}
                          className="form-card mt-2"

                        >
                          <h4>Record conflict decision</h4>
                          <div className="field">
                            <label htmlFor={`outcome-${check.id}`}>Outcome</label>
                            <select id={`outcome-${check.id}`} name="outcome" defaultValue="approved_with_controls">
                              <option value="clear">Clear (false positive / distinct parties)</option>
                              <option value="potential">Potential (under ongoing investigation)</option>
                              <option value="escalated">Escalate to Senior Partner / Compliance</option>
                              <option value="approved_with_controls">Approved with controls & safeguards</option>
                              <option value="cannot_act">Cannot act (prohibited conflict)</option>
                            </select>
                          </div>
                          <div className="field">
                            <label htmlFor={`rationale-${check.id}`}>Rationale</label>
                            <textarea
                              id={`rationale-${check.id}`}
                              name="rationale"
                              rows={2}
                              required
                              minLength={10}
                              maxLength={2000}
                              placeholder="Explain why the firm may act or why controls are sufficient..."
                            />
                          </div>
                          <div className="field">
                            <label htmlFor={`safeguards-${check.id}`}>Safeguards (one per line)</label>
                            <textarea
                              id={`safeguards-${check.id}`}
                              name="safeguards"
                              rows={2}
                              placeholder="e.g. Information barrier erected&#10;Separate partner supervision"
                            />
                          </div>
                          <div className="flex gap-2">
                            <button type="submit" disabled={saving} className="button primary">
                              {saving ? 'Recording…' : 'Record decision'}
                            </button>
                            <button
                              type="button"
                              className="button secondary"
                              onClick={() => setActiveDecisionCheckId(null)}
                            >
                              Cancel
                            </button>
                          </div>
                        </form>
                      ) : (
                        <button
                          type="button"
                          className="button secondary"
                          onClick={() => setActiveDecisionCheckId(check.id)}
                        >
                          {latestDecision ? 'Update decision / safeguards' : 'Record conflict decision'}
                        </button>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}
