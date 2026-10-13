import { describe, expect, it } from 'vitest';
import { ChronologyExtractorService } from './chronology-extractor.service.js';
import type { ChronologyEntry } from './ai.types.js';

describe('ChronologyExtractorService (Step 18c)', () => {
  const service = new ChronologyExtractorService();

  it('parses multiple UK legal date formats into standardized YYYY-MM-DD format', () => {
    expect(service.parseStandardDate('2024-05-20')).toBe('2024-05-20');
    expect(service.parseStandardDate('15 March 2024')).toBe('2024-03-15');
    expect(service.parseStandardDate('1st January 2023')).toBe('2023-01-01');
    expect(service.parseStandardDate('23rd November 2022')).toBe('2022-11-23');
    expect(service.parseStandardDate('04/07/2021')).toBe('2021-07-04');
    expect(service.parseStandardDate('12-10-2020')).toBe('2020-10-12');
    expect(service.parseStandardDate('Invalid Date String')).toBeNull();
  });

  it('sorts chronology entries in chronological order', () => {
    const entries: ChronologyEntry[] = [
      {
        date: '2024-06-01',
        eventDescription: 'Letter of Claim served',
        actorsInvolved: ['Claimant Solicitor'],
        sourceDocumentId: 'doc-1',
        sourceDocumentTitle: 'Letter of Claim.pdf',
        quote: 'We write to notify you...',
      },
      {
        date: '15 January 2024',
        eventDescription: 'Contract executed',
        actorsInvolved: ['Both Parties'],
        sourceDocumentId: 'doc-2',
        sourceDocumentTitle: 'Contract.pdf',
        quote: 'Agreed on this 15th day...',
      },
      {
        date: '2023-11-01',
        eventDescription: 'Initial tender issued',
        actorsInvolved: ['Tender Board'],
        sourceDocumentId: 'doc-3',
        sourceDocumentTitle: 'Tender.pdf',
        quote: 'Tender invitations issued...',
      },
    ];

    const sorted = service.sortChronology(entries);
    expect(sorted[0]?.date).toBe('2023-11-01');
    expect(sorted[1]?.date).toBe('15 January 2024');
    expect(sorted[2]?.date).toBe('2024-06-01');
  });

  it('formats chronology into standard markdown table with citations', () => {
    const entries: ChronologyEntry[] = [
      {
        date: '2024-02-14',
        eventDescription: 'Notice of default served by registered post',
        actorsInvolved: ['Landlord Agent'],
        sourceDocumentId: 'doc-4',
        sourceDocumentTitle: 'Default Notice.pdf',
        pageNumber: 2,
        quote: 'Formal notice of breach',
      },
    ];

    const md = service.formatToMarkdown(entries, 'Commercial Dispute');
    expect(md).toContain('### Chronology of Events — Commercial Dispute');
    expect(md).toContain('| **2024-02-14** | Notice of default served by registered post | Landlord Agent | [Default Notice.pdf] p. 2 | "Formal notice of breach" |');
    expect(md).toContain('Chronology Notes');
  });

  it('extracts heuristic chronology entries from document text containing dates', () => {
    const docs = [
      {
        id: 'doc-5',
        title: 'Correspondence.pdf',
        content: 'On 2024-03-10 the defendant failed to deliver agreed goods. Later on 15 April 2024 further discussions took place.',
      },
    ];

    const entries = service.extractHeuristicEntries(docs);
    expect(entries.length).toBeGreaterThanOrEqual(1);
    expect(entries[0]?.sourceDocumentId).toBe('doc-5');
    expect(entries[0]?.date).toBe('2024-03-10');
  });
});
