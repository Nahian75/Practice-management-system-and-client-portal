import { describe, expect, it } from 'vitest';
import { ChainChecker, GENESIS, sealHash, type CanonicalEvent, type StoredSeal } from './audit-digest.js';

const EVENT: CanonicalEvent = {
  id: '0190a000-0000-7000-8000-000000000001',
  occurred_at: '2026-10-23T09:00:00.123456Z',
  actor_type: 'user',
  actor_id: '0190a000-0000-7000-8000-0000000000aa',
  action: 'document.downloaded',
  outcome: 'success',
  resource_type: 'document',
  resource_id: '0190a000-0000-7000-8000-0000000000bb',
  ip_address: '127.0.0.1/32',
  user_agent: null,
  metadata: '{"version": 1}',
};

function chainOf(events: CanonicalEvent[]) {
  let previous: Buffer = GENESIS;
  return events.map((event, index) => {
    previous = sealHash(previous, event);
    return { seq: String(index + 1), hash: previous, event };
  });
}

describe('sealHash', () => {
  it('is the same for the same event and predecessor', () => {
    expect(sealHash(GENESIS, EVENT)).toEqual(sealHash(GENESIS, { ...EVENT }));
  });

  it.each(Object.keys(EVENT) as (keyof CanonicalEvent)[])('changes when %s changes', (field) => {
    expect(sealHash(GENESIS, { ...EVENT, [field]: `${EVENT[field] ?? ''}x` })).not.toEqual(sealHash(GENESIS, EVENT));
  });

  it('tells a missing value from an empty one', () => {
    expect(sealHash(GENESIS, { ...EVENT, user_agent: '' })).not.toEqual(sealHash(GENESIS, EVENT));
  });

  it('depends on the seal before it', () => {
    expect(sealHash(Buffer.alloc(32, 1), EVENT)).not.toEqual(sealHash(GENESIS, EVENT));
  });
});

describe('ChainChecker', () => {
  const events = [EVENT, { ...EVENT, id: `${EVENT.id.slice(0, -1)}2` }, { ...EVENT, id: `${EVENT.id.slice(0, -1)}3` }];

  it('accepts an untouched chain and reports its head', () => {
    const checker = new ChainChecker();
    const seals = chainOf(events);
    seals.forEach((seal) => checker.check(seal));

    expect(checker.problems).toEqual([]);
    expect(checker.head).toEqual({ seq: '3', hash: seals[2]?.hash });
  });

  it('reports each changed event, removed event and gap', () => {
    const checker = new ChainChecker();
    const [first, second, third] = chainOf(events) as [StoredSeal, StoredSeal, StoredSeal];
    checker.check({ ...first, event: { ...EVENT, outcome: 'denied' } });
    checker.check({ ...second, event: null });
    checker.check({ ...third, seq: '5' });

    expect(checker.problems).toEqual([
      { seq: '1', problem: 'event_changed' },
      { seq: '2', problem: 'event_missing' },
      { seq: '5', problem: 'out_of_order' },
    ]);
  });
});
