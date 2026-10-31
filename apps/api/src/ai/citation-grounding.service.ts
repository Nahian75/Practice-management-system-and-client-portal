import { Injectable } from '@nestjs/common';
import type { AiDocumentContext, GroundingVerificationResult, StructuredCitation } from './ai.types.js';

@Injectable()
export class CitationGroundingService {
  /**
   * Normalizes text for comparison: lowercases, removes non-alphanumeric punctuation,
   * collapses whitespace.
   */
  normalizeText(text: string): string {
    return (text || '')
      .toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * Calculates word-level Jaccard similarity between two strings.
   */
  calculateWordSimilarity(a: string, b: string): number {
    const wordsA = new Set(this.normalizeText(a).split(' ').filter(Boolean));
    const wordsB = new Set(this.normalizeText(b).split(' ').filter(Boolean));
    if (wordsA.size === 0 || wordsB.size === 0) return 0;

    let intersection = 0;
    for (const w of wordsA) {
      if (wordsB.has(w)) intersection++;
    }

    const union = new Set([...wordsA, ...wordsB]).size;
    return union > 0 ? intersection / union : 0;
  }

  /**
   * Verifies that each citation references a valid matter document and that
   * the quoted excerpt actually exists in the underlying document content.
   */
  verifyCitations(
    citations: StructuredCitation[],
    sourceDocuments: AiDocumentContext[],
  ): GroundingVerificationResult {
    if (!citations || citations.length === 0) {
      return {
        grounded: true,
        verificationScore: 1.0,
        verifiedCitations: [],
        unverifiedCount: 0,
        hallucinationWarning: null,
      };
    }

    const docMap = new Map<string, string>();
    for (const doc of sourceDocuments) {
      docMap.set(doc.id, this.normalizeText(doc.content));
    }

    let verifiedCount = 0;
    const verifiedDetails: Array<StructuredCitation & { verified: boolean; matchSimilarity: number }> = [];

    for (const citation of citations) {
      const docNormalizedText = docMap.get(citation.sourceDocumentId);

      if (!docNormalizedText) {
        verifiedDetails.push({
          ...citation,
          verified: false,
          matchSimilarity: 0.0,
        });
        continue;
      }

      const quoteNormalized = this.normalizeText(citation.quote);

      if (!quoteNormalized) {
        verifiedDetails.push({
          ...citation,
          verified: false,
          matchSimilarity: 0.0,
        });
        continue;
      }

      // Direct exact normalized substring match.
      if (docNormalizedText.includes(quoteNormalized)) {
        verifiedCount++;
        verifiedDetails.push({
          ...citation,
          verified: true,
          matchSimilarity: 1.0,
        });
        continue;
      }

      // Fuzzy matches require at least 85% of quote words to occur in the document.
      const quoteWords = quoteNormalized.split(' ').filter(Boolean);
      let matchedWords = 0;
      for (const word of quoteWords) {
        if (docNormalizedText.includes(word)) matchedWords++;
      }
      const wordMatchRatio = quoteWords.length > 0 ? matchedWords / quoteWords.length : 0;
      const verified = wordMatchRatio >= 0.85;
      if (verified) verifiedCount++;
      verifiedDetails.push({ ...citation, verified, matchSimilarity: wordMatchRatio });
    }

    const unverifiedCount = citations.length - verifiedCount;
    const verificationScore = citations.length > 0 ? verifiedCount / citations.length : 1.0;
    const grounded = unverifiedCount === 0;

    const hallucinationWarning = grounded
      ? null
      : `Regulatory Notice (SRA Code 1.4 & 2.1): ${unverifiedCount} of ${citations.length} citation(s) could not be verified against the matter's source documents. Verify all quotes and assertions independently before reliance or client issue.`;

    return {
      grounded,
      verificationScore,
      verifiedCitations: verifiedDetails,
      unverifiedCount,
      hallucinationWarning,
    };
  }
}
