import { describe, expect, it } from 'vitest';
import { CitationGroundingService } from './citation-grounding.service.js';

describe('CitationGroundingService (Step 18c)', () => {
  const service = new CitationGroundingService();

  const mockContext = [
    {
      id: 'doc-uuid-1',
      title: 'Commercial Lease Agreement.pdf',
      content:
        'The Tenant covenants to pay rent quarterly in advance on the usual quarter days. ' +
        'Interest on late rent shall accrue at 4% above the Bank of England base rate. ' +
        'The Landlord may re-enter the premises if rent remains unpaid for 21 days.',
    },
  ];

  it('validates exact matching quotations as fully grounded (score 1.0)', () => {
    const citations = [
      {
        sourceDocumentId: 'doc-uuid-1',
        documentTitle: 'Commercial Lease Agreement.pdf',
        pageNumber: 1,
        quote: 'The Tenant covenants to pay rent quarterly in advance on the usual quarter days.',
      },
    ];

    const result = service.verifyCitations(citations, mockContext);
    expect(result.grounded).toBe(true);
    expect(result.verificationScore).toBe(1.0);
    expect(result.unverifiedCount).toBe(0);
    expect(result.hallucinationWarning).toBeNull();
    expect(result.verifiedCitations[0]?.verified).toBe(true);
  });

  it('validates fuzzy normalized quotations with minor punctuation differences', () => {
    const citations = [
      {
        sourceDocumentId: 'doc-uuid-1',
        documentTitle: 'Commercial Lease Agreement.pdf',
        pageNumber: 1,
        quote: 'Interest on late rent shall accrue at 4% above the Bank of England base rate',
      },
    ];

    const result = service.verifyCitations(citations, mockContext);
    expect(result.grounded).toBe(true);
    expect(result.verifiedCitations[0]?.verified).toBe(true);
  });

  it('detects hallucinated quote not present in underlying document', () => {
    const citations = [
      {
        sourceDocumentId: 'doc-uuid-1',
        documentTitle: 'Commercial Lease Agreement.pdf',
        pageNumber: 1,
        quote: 'The Tenant is entitled to terminate early without penalty upon 14 days notice.',
      },
    ];

    const result = service.verifyCitations(citations, mockContext);
    expect(result.grounded).toBe(false);
    expect(result.verificationScore).toBe(0);
    expect(result.unverifiedCount).toBe(1);
    expect(result.hallucinationWarning).toContain('Regulatory Notice (SRA Code 1.4 & 2.1)');
    expect(result.verifiedCitations[0]?.verified).toBe(false);
  });

  it('detects citations pointing to unknown document IDs', () => {
    const citations = [
      {
        sourceDocumentId: 'non-existent-uuid',
        documentTitle: 'Unknown.pdf',
        pageNumber: 1,
        quote: 'Some statement.',
      },
    ];

    const result = service.verifyCitations(citations, mockContext);
    expect(result.grounded).toBe(false);
    expect(result.unverifiedCount).toBe(1);
    expect(result.verifiedCitations[0]?.verified).toBe(false);
  });

  it('preserves the inclusive 85% fuzzy threshold and mixed citation totals', () => {
    const matchingWords = Array.from({ length: 20 }, (_, index) => `term${index}`);
    const context = [{ id: 'threshold-document', title: 'Threshold', content: matchingWords.join(' ') }];
    const citations = [17, 16].map((matchCount) => ({
      sourceDocumentId: 'threshold-document',
      documentTitle: 'Threshold',
      quote: [...matchingWords.slice(0, matchCount), ...Array<string>(20 - matchCount).fill('absent')].join(' '),
    }));

    const result = service.verifyCitations(citations, context);

    expect(result.verifiedCitations.map(({ verified, matchSimilarity }) => ({ verified, matchSimilarity }))).toEqual([
      { verified: true, matchSimilarity: 0.85 },
      { verified: false, matchSimilarity: 0.8 },
    ]);
    expect(result.grounded).toBe(false);
    expect(result.verificationScore).toBe(0.5);
    expect(result.unverifiedCount).toBe(1);
    expect(result.hallucinationWarning).toContain('1 of 2 citation(s)');
  });

  it('returns grounded: true when empty citation array is provided', () => {
    const result = service.verifyCitations([], mockContext);
    expect(result.grounded).toBe(true);
    expect(result.verificationScore).toBe(1.0);
    expect(result.unverifiedCount).toBe(0);
  });
});
