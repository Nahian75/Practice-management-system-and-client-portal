'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { ErrorSummary } from '@/components/error-summary';
import type { RiskSummary } from '@/lib/compliance';
import { messagesOf, postJson } from '@/lib/requests';

const NARRATIVES = [
  ['scopeReason', 'AML scope and reason'], ['clientRisk', 'Client risk'], ['serviceRisk', 'Service and delivery risk'],
  ['purposeAndNature', 'Purpose and intended nature'], ['fundingRisk', 'Funding and transaction risk'],
  ['sanctionsExposure', 'Sanctions exposure'], ['rationale', 'Overall rating rationale'], ['mitigations', 'Mitigations'],
  ['requiredChecks', 'Required checks'], ['monitoringPlan', 'Ongoing monitoring plan'],
] as const;
const FACTORS = [
  ['pep', 'PEP, family member or known close associate'], ['unusualTransactions', 'Unusual transactions'],
  ['complexStructure', 'Unusually complex ownership or structure'], ['cash', 'Cash involvement'],
  ['remoteInstruction', 'Remote instruction risk'], ['adverseInformation', 'Relevant adverse information'],
  ['sanctionsExposure', 'Sanctions ownership or control exposure'], ['thirdPartyFunding', 'Third-party funding'],
] as const;

export function MatterComplianceForms({ matterId, assessments, matterOpen, canClear }:
  { matterId: string; assessments: RiskSummary[]; matterOpen: boolean; canClear: boolean }) {
  const router = useRouter(); const [errors, setErrors] = useState<string[]>(); const [sending, setSending] = useState(false);
  async function assess(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = new FormData(event.currentTarget);
    const narrative = Object.fromEntries(NARRATIVES.map(([name]) => [name, String(form.get(name) ?? '').trim()])) as Record<string, string>;
    const jurisdictions = String(form.get('jurisdictions') ?? '').toUpperCase().split(/[\s,]+/).filter(Boolean);
    const problems = [
      ...(jurisdictions.length && jurisdictions.every((code) => /^[A-Z]{2}$/.test(code)) ? [] : ['Enter at least one two-letter jurisdiction code']),
      ...(Object.values(narrative).every((value) => value.length >= 20) ? [] : ['Give a tailored answer of at least 20 characters for every assessment question']),
      ...(new Set(Object.values(narrative).map((value) => value.toLowerCase().replace(/\s+/g, ' '))).size === NARRATIVES.length ? [] : ['Use a distinct tailored answer for every assessment question']),
    ];
    if (problems.length) { setErrors(problems); return; }
    const factors = Object.fromEntries(FACTORS.map(([name]) => [name, form.get(name) === 'on']));
    const body = { inScope: form.get('inScope') === 'yes', rating: form.get('rating'), factors,
      jurisdictions: [...new Set(jurisdictions)].sort(), expectedValue: form.get('expectedValue'),
      reviewDueOn: String(form.get('reviewDueOn') ?? ''), reviewGraceDays: Number(form.get('reviewGraceDays')),
      narrative: { ...narrative, loweringGrounds: String(form.get('loweringGrounds') ?? '').trim() || null } };
    setSending(true); setErrors(undefined);
    try { const response = await postJson(`/api/matters/${matterId}/aml-risk`, body);
      if (!response.ok) { setErrors(await messagesOf(response)); return; } router.refresh();
    } finally { setSending(false); }
  }
  async function clear(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = new FormData(event.currentTarget); const assessmentId = String(form.get('assessmentId') ?? '');
    const reasoning = String(form.get('clearanceReasoning') ?? '').trim();
    if (!assessmentId || reasoning.length < 20) { setErrors(['Choose an assessment and enter tailored clearance reasoning']); return; }
    setSending(true); setErrors(undefined);
    try { const response = await postJson(`/api/matters/${matterId}/aml-risk/${assessmentId}/clearance`, { decision: form.get('decision'), reasoning });
      if (!response.ok) { setErrors(await messagesOf(response)); return; } router.refresh();
    } finally { setSending(false); }
  }
  if (!matterOpen) return <p>This closed matter cannot receive a new assessment.</p>;
  return <>{errors && <ErrorSummary messages={errors} />}
    <form aria-label="Record matter AML risk assessment" onSubmit={assess} noValidate><h2>New permanent assessment</h2>
      <fieldset className="fieldset"><legend>Within the Money Laundering Regulations?</legend><label><input type="radio" name="inScope" value="yes" defaultChecked /> Yes</label>{' '}<label><input type="radio" name="inScope" value="no" /> No</label></fieldset>
      <div className="field"><label className="label" htmlFor="rating">Overall risk rating</label><select className="select" id="rating" name="rating" defaultValue="standard"><option value="low">Low</option><option value="standard">Standard</option><option value="high">High</option></select></div>
      <fieldset className="fieldset"><legend>Risk factors</legend>{FACTORS.map(([name, label]) => <div key={name}><label><input type="checkbox" name={name} /> {label}</label></div>)}</fieldset>
      <div className="field"><label className="label" htmlFor="jurisdictions">Jurisdictions</label><span className="hint" id="jurisdictions-hint">Two-letter country codes, separated by commas, for example GB, FR.</span><input className="input" id="jurisdictions" name="jurisdictions" defaultValue="GB" aria-describedby="jurisdictions-hint" /></div>
      <div className="field"><label className="label" htmlFor="expectedValue">Expected value</label><select className="select" id="expectedValue" name="expectedValue"><option value="none">No transaction value</option><option value="under_10k">Under GBP 10,000</option><option value="10k_to_100k">GBP 10,000 to 100,000</option><option value="100k_to_1m">GBP 100,000 to 1 million</option><option value="over_1m">Over GBP 1 million</option></select></div>
      <div className="field"><label className="label" htmlFor="reviewDueOn">Review due</label><input className="input input-date" id="reviewDueOn" name="reviewDueOn" type="date" /></div>
      <div className="field"><label className="label" htmlFor="reviewGraceDays">Work grace period in days</label><input className="input input-short" id="reviewGraceDays" name="reviewGraceDays" type="number" min="0" max="90" defaultValue="0" /></div>
      {NARRATIVES.map(([name, label]) => <div className="field" key={name}><label className="label" htmlFor={name}>{label}</label><textarea className="input" id={name} name={name} rows={3} maxLength={10000} /></div>)}
      <div className="field"><label className="label" htmlFor="loweringGrounds">Grounds for lowering the previous rating (when applicable)</label><textarea className="input" id="loweringGrounds" name="loweringGrounds" rows={3} maxLength={10000} /></div>
      <button className="button" type="submit" disabled={sending}>Submit fixed assessment</button></form>
    {canClear && !!assessments.length && <form aria-label="Record Compliance clearance" onSubmit={clear} noValidate><hr className="rule" /><h2>Compliance decision</h2>
      <div className="field"><label className="label" htmlFor="assessmentId">Assessment</label><select className="select" id="assessmentId" name="assessmentId" defaultValue={assessments[0]!.id}>{assessments.map((item) => <option key={item.id} value={item.id}>Version {item.version}: {item.rating}</option>)}</select></div>
      <div className="field"><label className="label" htmlFor="decision">Decision</label><select className="select" id="decision" name="decision"><option value="approved">Approve</option><option value="refused">Refuse</option></select></div>
      <div className="field"><label className="label" htmlFor="clearanceReasoning">Reasoning</label><textarea className="input" id="clearanceReasoning" name="clearanceReasoning" rows={4} maxLength={10000} /></div>
      <button className="button" type="submit" disabled={sending}>Record permanent decision</button></form>}
  </>;
}
