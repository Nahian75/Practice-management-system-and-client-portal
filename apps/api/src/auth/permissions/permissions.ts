import type { StaffRole } from '../../database/schema.js';

/**
 * Every permission in the system. Each module adds its own when it is built.
 * Changes here are reviewed like any other code: see ADR-009.
 */
export const PERMISSIONS = [
  'staff.view',
  'staff.invite',
  'staff.roles.manage',
  'staff.disable',
  'audit.view',
  'clients.create',
  'clients.view',
  'clients.search',
  'clients.edit',
  'clients.take_over',
  'matters.open',
  'matters.view',
  'matters.edit',
  'matters.supervise',
  'matters.access_with_reason',
  'documents.view',
  'documents.add',
  'documents.withdraw',
  'documents.share',
  'portal.invite',
  'tasks.view',
  'tasks.create',
  'tasks.manage',
  'time.record',
  'finance.matter.view',
  'finance.view_all',
  'rates.manage',
  'bills.manage',
  'client_money.record',
  'client_money.request',
  'client_money.approve',
  'finance.reconcile',
  'finance.reconciliation_sign_off',
  'aml.officers.manage',
  'aml.firm_controls',
  'aml.firm_approve',
  'aml.assess',
  'aml.view_evidence',
  'aml.approve',
  'aml.sanctions',
  'aml.internal_report',
  'aml.retention',
  'aml.export',
  'hr.directory',
  'hr.manage',
  'hr.leave',
  'hr.health',
  'hr.vetting',
  'hr.competence',
  'hr.cases',
  'hr.retention',
  'hr.export',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export const STAFF_ROLES = ['administrator', 'partner', 'fee_earner', 'accounts', 'compliance', 'hr'] as const satisfies readonly StaffRole[];

/**
 * Roles whose last active holder cannot be removed: without an administrator
 * nobody can manage staff, and without compliance nobody can read the audit log.
 */
export const PROTECTED_ROLES = ['administrator', 'compliance'] as const satisfies readonly StaffRole[];

export type ProtectedRole = (typeof PROTECTED_ROLES)[number];

/**
 * Roles whose grant is emailed to every compliance holder: they reach staff
 * management, the audit log, client money and personnel records, so a grant
 * made through a misused administrator account must not go unnoticed.
 */
export const SENSITIVE_ROLES: readonly StaffRole[] = ['administrator', 'compliance', 'accounts', 'hr'];

/** What each role allows. Matches the table in docs/authorization.md. */
export const ROLE_PERMISSIONS: Readonly<Record<StaffRole, readonly Permission[]>> = {
  administrator: ['staff.view', 'staff.invite', 'staff.roles.manage', 'staff.disable', 'aml.officers.manage', 'aml.internal_report', 'hr.directory'],
  partner: [
    'staff.view',
    'clients.create',
    'clients.view',
    'clients.search',
    'clients.edit',
    'clients.take_over',
    'matters.open',
    'matters.view',
    'matters.edit',
    'matters.supervise',
    'documents.view',
    'documents.add',
    'documents.withdraw',
    'documents.share',
    'portal.invite',
    'tasks.view',
    'tasks.create',
    'tasks.manage',
    'time.record',
    'finance.matter.view',
    'aml.firm_approve',
    'aml.assess',
    'aml.view_evidence',
    'aml.internal_report',
    'hr.directory',
  ],
  fee_earner: [
    'clients.create',
    'clients.view',
    'clients.search',
    'clients.edit',
    'matters.open',
    'matters.view',
    'matters.edit',
    'documents.view',
    'documents.add',
    'documents.withdraw',
    'documents.share',
    'portal.invite',
    'tasks.view',
    'tasks.create',
    'tasks.manage',
    'time.record',
    'finance.matter.view',
    'aml.assess',
    'aml.view_evidence',
    'aml.internal_report',
    'hr.directory',
  ],
  accounts: [
    'finance.matter.view', 'finance.view_all', 'rates.manage', 'bills.manage',
    'client_money.record', 'client_money.request', 'client_money.approve',
    'finance.reconcile',
    'aml.internal_report',
    'hr.directory',
  ],
  compliance: [
    'staff.view', 'audit.view', 'matters.access_with_reason', 'finance.matter.view',
    'finance.view_all', 'finance.reconciliation_sign_off',
    'aml.firm_controls',
    'aml.assess',
    'aml.view_evidence',
    'aml.approve',
    'aml.sanctions',
    'aml.internal_report',
    'aml.retention',
    'aml.export',
    'hr.directory',
  ],
  hr: ['aml.internal_report', 'hr.directory', 'hr.manage', 'hr.leave', 'hr.health', 'hr.vetting', 'hr.competence',
    'hr.cases', 'hr.retention', 'hr.export'],
};

export function permissionsFor(roles: Iterable<StaffRole>): ReadonlySet<Permission> {
  const granted = new Set<Permission>();
  for (const role of roles) {
    for (const permission of ROLE_PERMISSIONS[role]) {
      granted.add(permission);
    }
  }
  return granted;
}
