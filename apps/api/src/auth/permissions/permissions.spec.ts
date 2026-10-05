import { describe, expect, it } from 'vitest';
import { PERMISSIONS, permissionsFor, ROLE_PERMISSIONS, STAFF_ROLES } from './permissions.js';

/**
 * The table in docs/authorization.md, as data. Changing what a role may do
 * means changing this test too, which makes the change visible in review.
 */
const EXPECTED: Record<string, Record<string, boolean>> = {
  'staff.view': { administrator: true, partner: true, fee_earner: false, accounts: false, compliance: true },
  'staff.invite': { administrator: true, partner: false, fee_earner: false, accounts: false, compliance: false },
  'staff.roles.manage': { administrator: true, partner: false, fee_earner: false, accounts: false, compliance: false },
  'staff.disable': { administrator: true, partner: false, fee_earner: false, accounts: false, compliance: false },
  'audit.view': { administrator: false, partner: false, fee_earner: false, accounts: false, compliance: true },
  'clients.create': { administrator: false, partner: true, fee_earner: true, accounts: false, compliance: false },
  'clients.view': { administrator: false, partner: true, fee_earner: true, accounts: false, compliance: false },
  'clients.search': { administrator: false, partner: true, fee_earner: true, accounts: false, compliance: false },
  'clients.edit': { administrator: false, partner: true, fee_earner: true, accounts: false, compliance: false },
  'clients.take_over': { administrator: false, partner: true, fee_earner: false, accounts: false, compliance: false },
  'matters.open': { administrator: false, partner: true, fee_earner: true, accounts: false, compliance: false },
  'matters.view': { administrator: false, partner: true, fee_earner: true, accounts: false, compliance: false },
  'matters.edit': { administrator: false, partner: true, fee_earner: true, accounts: false, compliance: false },
  'matters.access_with_reason': { administrator: false, partner: false, fee_earner: false, accounts: false, compliance: true },
  'matters.supervise': { administrator: false, partner: true, fee_earner: false, accounts: false, compliance: false },
  'documents.add': { administrator: false, partner: true, fee_earner: true, accounts: false, compliance: false },
};

describe('role permissions', () => {
  it('cover exactly the permissions in the documented table', () => {
    expect([...PERMISSIONS].sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  it.each(PERMISSIONS.flatMap((permission) => STAFF_ROLES.map((role) => [permission, role] as const)))(
    '%s for %s matches the table',
    (permission, role) => {
      expect(ROLE_PERMISSIONS[role].includes(permission)).toBe(EXPECTED[permission]?.[role]);
    },
  );

  it('keeps reading the audit log away from administrators', () => {
    expect(permissionsFor(['administrator']).has('audit.view')).toBe(false);
  });

  it('combines the permissions of every role held', () => {
    expect([...permissionsFor(['partner', 'compliance'])].sort()).toEqual(['audit.view', 'clients.create', 'clients.edit', 'clients.search', 'clients.take_over', 'clients.view', 'documents.add', 'matters.access_with_reason', 'matters.edit', 'matters.open', 'matters.supervise', 'matters.view', 'staff.view']);
  });

  it('gives no permissions without roles', () => {
    expect(permissionsFor([]).size).toBe(0);
  });
});
