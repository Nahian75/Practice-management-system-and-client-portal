export const POLICY_KIND_LABELS = {
  aml_policy: 'Anti-money laundering',
  sanctions_policy: 'Sanctions',
  conflicts_policy: 'Conflicts',
  client_care_policy: 'Client care',
  complaints_policy: 'Complaints',
  confidentiality_policy: 'Confidentiality',
  data_protection_policy: 'Data protection',
  retention_policy: 'Retention',
  information_security_policy: 'Information security',
  finance_policy: 'Finance',
} as const;

export type PolicyKind = keyof typeof POLICY_KIND_LABELS;

export interface PolicyAcknowledgement {
  id: string;
  controlVersionId: string;
  account: { accountId: string; displayName: string };
  acknowledgedAt: string;
}

export interface PolicyVersion {
  id: string;
  kind: PolicyKind | 'ml_tf_risk_assessment' | 'proliferation_financing_risk_assessment'
    | 'sanctions_risk_assessment' | 'training_material';
  version: number;
  title: string;
  content: string;
  contentSha256: string;
  source: string;
  effectiveFrom: string;
  reviewDueOn: string;
  owner: { accountId: string; displayName: string };
  requiresAcknowledgement: boolean;
  acknowledgementDueDays: number | null;
  preparedBy: { accountId: string; displayName: string };
  preparedAt: string;
  approval: { id: string; approvedBy: { accountId: string; displayName: string }; approvedAt: string } | null;
}

export interface StaffPolicy extends PolicyVersion {
  kind: PolicyKind;
  acknowledgement: PolicyAcknowledgement | null;
  acknowledgementDueOn: string | null;
}
