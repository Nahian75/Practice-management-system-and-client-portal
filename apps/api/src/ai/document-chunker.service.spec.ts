import { describe, expect, it } from 'vitest';
import { DocumentChunkerService } from './document-chunker.service.js';

describe('DocumentChunkerService (Step 18c)', () => {
  const service = new DocumentChunkerService();

  it('normalizes document text by stripping null bytes and collapsing excessive whitespace', () => {
    const raw = 'Clause 1.\x00\r\n\r\n  Payment shall be due within   30 days.\n\n\n\nClause 2.';
    const normalized = service.normalizeText(raw);
    expect(normalized).not.toContain('\x00');
    expect(normalized).not.toContain('\r');
    expect(normalized).toContain('Clause 1.\n\n Payment shall be due within 30 days.\n\nClause 2.');
  });

  it('estimates token counts based on ~4 characters per token', () => {
    expect(service.estimateTokens('Hello world')).toBe(3);
    expect(service.estimateTokens('')).toBe(0);
  });

  it('returns single chunk for documents within max chunk size', () => {
    const text = 'This is a brief lease summary that easily fits in one chunk.';
    const chunks = service.chunkDocument('doc-1', 'Lease.pdf', text, { maxChunkSizeChars: 500 });

    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.chunkIndex).toBe(0);
    expect(chunks[0]?.totalChunks).toBe(1);
    expect(chunks[0]?.documentId).toBe('doc-1');
    expect(chunks[0]?.documentTitle).toBe('Lease.pdf');
    expect(chunks[0]?.text).toBe(text);
  });

  it('splits large text into overlapping chunks respecting sentence boundaries', () => {
    const p1 = 'First sentence of the agreement. Second sentence detailing indemnity.';
    const p2 = 'Third sentence specifying governing law and English court jurisdiction.';
    const fullText = `${p1}\n\n${p2}`;

    const chunks = service.chunkDocument('doc-2', 'Contract.pdf', fullText, {
      maxChunkSizeChars: 80,
      overlapChars: 20,
    });

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]?.totalChunks).toBe(chunks.length);
    // Check that each chunk contains valid text
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeGreaterThan(0);
      expect(chunk.documentId).toBe('doc-2');
    }
    // Verify first chunk starts with initial sentence
    expect(chunks[0]?.text).toContain('First sentence');
  });
});
