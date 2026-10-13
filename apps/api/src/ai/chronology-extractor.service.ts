import { Injectable } from '@nestjs/common';
import type { ChronologyEntry, AiDocumentContext } from './ai.types.js';

@Injectable()
export class ChronologyExtractorService {
  private readonly dateRegex =
    /\b(?:(\d{4}-\d{2}-\d{2})|(\d{1,2}(?:st|nd|rd|th)?\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4})|(\d{1,2}[/-]\d{1,2}[/-]\d{4}))\b/gi;

  /**
   * Parses common UK date string variations into a standardized YYYY-MM-DD string for sorting.
   */
  parseStandardDate(dateStr: string): string | null {
    if (!dateStr) return null;
    const trimmed = dateStr.trim();

    // 1. ISO format: YYYY-MM-DD
    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
      return trimmed;
    }

    // 2. Format: 15 March 2024 / 15th March 2024
    const monthNames: Record<string, string> = {
      january: '01',
      february: '02',
      march: '03',
      april: '04',
      may: '05',
      june: '06',
      july: '07',
      august: '08',
      september: '09',
      october: '10',
      november: '11',
      december: '12',
    };

    const textDateMatch = trimmed.match(
      /^(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]+)\s+(\d{4})$/,
    );
    if (textDateMatch) {
      const day = textDateMatch[1]!.padStart(2, '0');
      const monthStr = textDateMatch[2]!.toLowerCase();
      const month = monthNames[monthStr];
      const year = textDateMatch[3]!;
      if (month) {
        return `${year}-${month}-${day}`;
      }
    }

    // 3. Format: DD/MM/YYYY or DD-MM-YYYY
    const slashMatch = trimmed.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
    if (slashMatch) {
      const day = slashMatch[1]!.padStart(2, '0');
      const month = slashMatch[2]!.padStart(2, '0');
      const year = slashMatch[3]!;
      return `${year}-${month}-${day}`;
    }

    return null;
  }

  /**
   * Sorts chronology entries chronologically by standard date.
   */
  sortChronology(entries: ChronologyEntry[]): ChronologyEntry[] {
    return [...entries].sort((a, b) => {
      const dateA = this.parseStandardDate(a.date) ?? a.date;
      const dateB = this.parseStandardDate(b.date) ?? b.date;
      return dateA.localeCompare(dateB);
    });
  }

  /**
   * Formats chronology entries into structured legal markdown with a tabular summary
   * and linked verifiable citations.
   */
  formatToMarkdown(entries: ChronologyEntry[], matterTitle?: string): string {
    const sorted = this.sortChronology(entries);
    if (sorted.length === 0) {
      return '_No chronological events extracted from source documents._';
    }

    let md = `### Chronology of Events${matterTitle ? ` — ${matterTitle}` : ''}\n\n`;
    md += '| Date | Event Description | Actors | Source & Page | Citation Quote |\n';
    md += '| :--- | :--- | :--- | :--- | :--- |\n';

    for (const entry of sorted) {
      const actors = entry.actorsInvolved.length > 0 ? entry.actorsInvolved.join(', ') : '—';
      const page = entry.pageNumber ? ` p. ${entry.pageNumber}` : '';
      const source = `[${entry.sourceDocumentTitle}]${page}`;
      const quote = entry.quote ? `"${entry.quote.replace(/"/g, "'")}"` : '—';
      const desc = entry.eventDescription.replace(/\|/g, '-');

      md += `| **${entry.date}** | ${desc} | ${actors} | ${source} | ${quote} |\n`;
    }

    md += '\n#### Chronology Notes\n';
    md += '- All dates and statements are extracted directly from underlying matter files.\n';
    md += '- Verify critical limitation periods, notice dates, and filing deadlines against primary source material.\n';

    return md;
  }

  /**
   * Extracts initial date occurrences and context sentences from raw documents as fallback
   * or offline heuristic.
   */
  extractHeuristicEntries(docs: AiDocumentContext[]): ChronologyEntry[] {
    const entries: ChronologyEntry[] = [];

    for (const doc of docs) {
      const sentences = doc.content.split(/[.\n]+/).map((s) => s.trim()).filter(Boolean);

      for (const sentence of sentences) {
        const matches = Array.from(sentence.matchAll(this.dateRegex));
        for (const match of matches) {
          const rawDate = match[0];
          if (rawDate) {
            entries.push({
              date: rawDate,
              time: null,
              eventDescription: sentence.slice(0, 200),
              actorsInvolved: [],
              sourceDocumentId: doc.id,
              sourceDocumentTitle: doc.title,
              pageNumber: 1,
              quote: sentence.slice(0, 150),
              importance: 'material',
            });
            break; // One entry per sentence
          }
        }
      }
    }

    return this.sortChronology(entries);
  }
}
