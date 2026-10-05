/** Staff accounts as the API returns them (apps/api/src/staff), and how their codes are shown. */

export const STAFF_ROLE_LABELS = {
  administrator: 'Administrator',
  partner: 'Partner',
  fee_earner: 'Fee earner',
  accounts: 'Accounts',
  compliance: 'Compliance',
} as const;

/** What each role is for, as docs/authorization.md describes it. */
export const STAFF_ROLE_PURPOSES: Record<StaffRole, string> = {
  administrator: 'Manages staff accounts and roles',
  partner: 'Supervises matters and fee earners',
  fee_earner: 'Runs matters day to day',
  accounts: 'Client and office money, bills, reconciliation',
  compliance: 'Regulatory oversight and the audit log',
};

export const ACCOUNT_STATUS_LABELS = { invited: 'Invited', active: 'Active', disabled: 'Disabled' } as const;

export type StaffRole = keyof typeof STAFF_ROLE_LABELS;

export interface StaffMember {
  id: string;
  email: string;
  displayName: string;
  status: keyof typeof ACCOUNT_STATUS_LABELS;
  roles: StaffRole[];
}
