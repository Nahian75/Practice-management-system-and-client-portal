import { describe, expect, it } from 'vitest';
import { RedactionService } from './redaction.service.js';

describe('RedactionService (Step 18b)', () => {
  const service = new RedactionService();

  it('redacts UK National Insurance numbers in various formats', () => {
    const text = 'Client NI: QQ 12 34 56 A and spouse NI: AB123456C';
    const result = service.redact(text);

    expect(result.redactedText).toBe('Client NI: [REDACTED_NI_NUMBER] and spouse NI: [REDACTED_NI_NUMBER]');
    expect(result.stats.niNumbersCount).toBe(2);
  });

  it('redacts Visa and MasterCard 16-digit card numbers', () => {
    const text = 'Payment made via 4532-1234-5678-9010 and 5412 7512 3412 3456';
    const result = service.redact(text);

    expect(result.redactedText).toBe('Payment made via [REDACTED_CARD_NUMBER] and [REDACTED_CARD_NUMBER]');
    expect(result.stats.cardsCount).toBe(2);
  });

  it('redacts bank sort codes and account numbers', () => {
    const text = 'Remit funds to sort code: 20-40-60, account: 12345678';
    const result = service.redact(text);

    expect(result.redactedText).toBe('Remit funds to sort code: [REDACTED_SORT_CODE], account: [REDACTED_BANK_ACCOUNT]');
    expect(result.stats.sortCodesCount).toBe(1);
    expect(result.stats.bankAccountsCount).toBe(1);
  });

  it('redacts credentials, passwords, and API tokens', () => {
    const text = 'Config: password=superSecret123, api_key: sk-live-987654321, bearer: token998877';
    const result = service.redact(text);

    expect(result.redactedText).toBe('Config: password=[REDACTED_CREDENTIAL], api_key: [REDACTED_CREDENTIAL], bearer: [REDACTED_CREDENTIAL]');
    expect(result.stats.credentialsCount).toBe(3);
  });

  it('redacts explicitly labeled dates of birth', () => {
    const text = 'Individual details: Name: John Smith, DOB: 14/05/1982, Born: 01-01-1990';
    const result = service.redact(text);

    expect(result.redactedText).toBe('Individual details: Name: John Smith, DOB: [REDACTED_DOB], Born: [REDACTED_DOB]');
    expect(result.stats.dobsCount).toBe(2);
  });

  it('preserves normal legal text, dates, and statute citations intact', () => {
    const text = 'The Limitation Act 1980 section 5 prescribes a 6-year period from the date of breach.';
    const result = service.redact(text);

    expect(result.redactedText).toBe(text);
    expect(result.stats.totalRedactions).toBe(0);
  });
});
