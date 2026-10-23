import type { Metadata } from 'next';
import { HowTo } from '@/components/how-to';
import { apiGet } from '@/lib/api';
import { formatCalendarDate, formatDateTime } from '@/lib/format';
import { POLICY_KIND_LABELS, type PolicyVersion, type StaffPolicy } from '@/lib/policies';
import type { StaffMember } from '@/lib/staff';
import { PolicyAcknowledgeButton, PolicyActions } from './policy-actions';

export const metadata: Metadata = { title: 'Firm policies' };

export default async function PoliciesPage() {
  const [mine, controls, pending, staff] = await Promise.all([
    apiGet<{ policies: StaffPolicy[] }>('/compliance/policies/me'),
    apiGet<{ controls: PolicyVersion[]; next: string | null }>('/compliance/controls'),
    apiGet<{ controls: PolicyVersion[]; next: string | null }>('/compliance/controls/pending-approval'),
    apiGet<{ staff: StaffMember[] }>('/staff'),
  ]);
  if (!mine.body) throw new Error('Could not load the firm policies');
  const pendingPolicies = (pending.body?.controls ?? []).filter((item) => item.kind in POLICY_KIND_LABELS);

  return <>
    <h1>Firm policies</h1>
    <HowTo>
      <li>Read each policy on this page.</li>
      <li>Select &ldquo;Acknowledge this version&rdquo; to confirm you have read it.</li>
      <li>Do this before the due date shown next to the button.</li>
    </HowTo>
    <p className="secondary">Approved policies that apply to your work. Acknowledging a policy records that you received this exact version; it does not replace required training.</p>
    {!mine.body.policies.length ? <p>No approved effective policies are available.</p> : mine.body.policies.map((policy) =>
      <section key={policy.id} aria-labelledby={`policy-${policy.id}`}><h2 id={`policy-${policy.id}`}>{policy.title}</h2>
        <dl className="details"><dt>Category</dt><dd>{POLICY_KIND_LABELS[policy.kind]}</dd><dt>Version</dt><dd>{policy.version}</dd>
          <dt>Owner</dt><dd>{policy.owner.displayName}</dd><dt>Effective</dt><dd>{formatCalendarDate(policy.effectiveFrom)}</dd>
          <dt>Review due</dt><dd>{formatCalendarDate(policy.reviewDueOn)}</dd><dt>Source</dt><dd>{policy.source}</dd></dl>
        <div className="pre-wrap">{policy.content}</div>
        {policy.requiresAcknowledgement && (policy.acknowledgement
          ? <p className="notice"><strong>Acknowledged</strong> {formatDateTime(policy.acknowledgement.acknowledgedAt)}.</p>
          : <p><PolicyAcknowledgeButton policyId={policy.id} /> {policy.acknowledgementDueOn && <>Due {formatCalendarDate(policy.acknowledgementDueOn)}.</>}</p>)}
      </section>)}
    <PolicyActions canCreate={controls.status === 200} pending={pendingPolicies} owners={staff.body?.staff ?? []} />
  </>;
}
