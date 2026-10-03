import { describe, expect, it, vi } from 'vitest';
import type { BreachCheckResult, BreachedPasswordChecker } from './breached-password-checker.js';
import { PasswordPolicy } from './password-policy.js';

const EMAIL = 'jane.doe@example.com';

function policyWithBreachResult(result: BreachCheckResult) {
  const check = vi.fn(async () => result);
  const checker = { check } as unknown as BreachedPasswordChecker;
  return { policy: new PasswordPolicy(checker), check };
}

describe('PasswordPolicy', () => {
  it('accepts a long password that is not breached', async () => {
    const { policy } = policyWithBreachResult('not_breached');

    expect(await policy.check('tidy-otter-quartz-lantern', EMAIL)).toEqual({
      problems: [],
      breachCheckSkipped: false,
    });
  });

  it('accepts exactly the minimum length', async () => {
    const { policy } = policyWithBreachResult('not_breached');

    expect((await policy.check('a'.repeat(12), EMAIL)).problems).toEqual([]);
  });

  it('rejects one character below the minimum', async () => {
    const { policy } = policyWithBreachResult('not_breached');

    expect((await policy.check('a'.repeat(11), EMAIL)).problems).toEqual(['too_short']);
  });

  it('counts characters, not bytes', async () => {
    const { policy } = policyWithBreachResult('not_breached');

    expect((await policy.check('🔒'.repeat(11), EMAIL)).problems).toEqual(['too_short']);
  });

  it('rejects passwords over the maximum length', async () => {
    const { policy } = policyWithBreachResult('not_breached');

    expect((await policy.check('a'.repeat(129), EMAIL)).problems).toEqual(['too_long']);
  });

  it('rejects a password containing the email name', async () => {
    const { policy } = policyWithBreachResult('not_breached');

    expect((await policy.check('Jane.Doe-2026-secure', EMAIL)).problems).toEqual(['contains_email']);
  });

  it('rejects a breached password', async () => {
    const { policy } = policyWithBreachResult('breached');

    expect((await policy.check('Password1234', EMAIL)).problems).toEqual(['breached']);
  });

  it('does not send a password that already failed a local rule to the breach service', async () => {
    const { policy, check } = policyWithBreachResult('not_breached');

    await policy.check('short', EMAIL);

    expect(check).not.toHaveBeenCalled();
  });

  it('accepts the password but flags the skipped check when the breach service is down', async () => {
    const { policy } = policyWithBreachResult('unavailable');

    expect(await policy.check('tidy-otter-quartz-lantern', EMAIL)).toEqual({
      problems: [],
      breachCheckSkipped: true,
    });
  });
});
