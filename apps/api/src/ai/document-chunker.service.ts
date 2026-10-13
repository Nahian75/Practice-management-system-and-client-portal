import { Injectable } from '@nestjs/common';
import type { DocumentChunk } from './ai.types.js';

export interface ChunkOptions {
  maxChunkSizeChars?: number;
  overlapChars?: number;
}

@Injectable()
export class DocumentChunkerService {
  /**
   * Normalizes document text: removes null/control characters, normalizes line breaks,
   * collapses excessive whitespace while preserving paragraphs.
   */
  normalizeText(text: string): string {
    if (!text) return '';
    return text
      .replace(/\0/g, '')
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      .replace(/[\t ]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  /**
   * Estimates token count from text using standard ~4 chars per token rule of thumb.
   */
  estimateTokens(text: string): number {
    if (!text) return 0;
    return Math.ceil(text.length / 4);
  }

  /**
   * Chunks a document into overlapping segments, respecting sentence/paragraph boundaries
   * where possible to prevent legal clauses from being truncated mid-meaning.
   */
  chunkDocument(
    documentId: string,
    documentTitle: string,
    rawText: string,
    options: ChunkOptions = {},
  ): DocumentChunk[] {
    const text = this.normalizeText(rawText);
    if (!text) return [];

    const maxSize = options.maxChunkSizeChars ?? 2000;
    const overlap = options.overlapChars ?? 200;

    if (text.length <= maxSize) {
      return [
        {
          chunkIndex: 0,
          totalChunks: 1,
          documentId,
          documentTitle,
          text,
          startChar: 0,
          endChar: text.length,
          estimatedTokens: this.estimateTokens(text),
        },
      ];
    }

    const chunks: Array<{ text: string; startChar: number; endChar: number }> = [];
    let start = 0;

    while (start < text.length) {
      let end = start + maxSize;
      if (end >= text.length) {
        end = text.length;
      } else {
        // Try finding a natural break (paragraph > sentence > semicolon)
        const searchSubstr = text.slice(start + Math.floor(maxSize * 0.7), end);
        const paragraphBreak = searchSubstr.lastIndexOf('\n\n');
        const sentenceBreak = searchSubstr.search(/[.?!]\s+(?=[A-Z0-9])/);
        const lineBreak = searchSubstr.lastIndexOf('\n');

        if (paragraphBreak !== -1) {
          end = start + Math.floor(maxSize * 0.7) + paragraphBreak + 2;
        } else if (sentenceBreak !== -1) {
          end = start + Math.floor(maxSize * 0.7) + sentenceBreak + 2;
        } else if (lineBreak !== -1) {
          end = start + Math.floor(maxSize * 0.7) + lineBreak + 1;
        }
      }

      const chunkText = text.slice(start, end).trim();
      if (chunkText.length > 0) {
        chunks.push({
          text: chunkText,
          startChar: start,
          endChar: end,
        });
      }

      if (end >= text.length) break;
      start = Math.max(start + 1, end - overlap);
    }

    const totalChunks = chunks.length;
    return chunks.map((c, index) => ({
      chunkIndex: index,
      totalChunks,
      documentId,
      documentTitle,
      text: c.text,
      startChar: c.startChar,
      endChar: c.endChar,
      estimatedTokens: this.estimateTokens(c.text),
    }));
  }
}
