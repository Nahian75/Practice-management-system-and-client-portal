import { Injectable } from '@nestjs/common';

export type AttendanceType =
  | 'telephone'
  | 'meeting'
  | 'court_hearing'
  | 'counsel_conference'
  | 'file_review';

export interface ActionItem {
  taskTitle: string;
  assignedTo?: string | null;
  dueOn?: string | null;
  priority?: 'low' | 'normal' | 'high' | 'urgent';
}

export interface AttendanceNoteStructured {
  matterTitle?: string;
  matterReference?: string;
  date: string;
  time?: string | null;
  attendanceType: AttendanceType;
  attendees: string[];
  feeEarner: string;
  synopsis: string;
  adviceGiven: string;
  actionItems: ActionItem[];
  estimatedMinutes?: number | null;
}

@Injectable()
export class AttendanceNotesService {
  /**
   * Parses and structures raw dictate text or jottings into formal structured attendance note.
   */
  structureRawNotes(
    rawText: string,
    context?: {
      matterTitle?: string;
      matterReference?: string;
      feeEarnerName?: string;
      defaultDate?: string;
    },
  ): AttendanceNoteStructured {
    const text = rawText || '';
    const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);

    // 1. Detect attendance type heuristics
    let attendanceType: AttendanceType = 'telephone';
    const lower = text.toLowerCase();
    if (lower.includes('court') || lower.includes('hearing') || lower.includes('judge')) {
      attendanceType = 'court_hearing';
    } else if (lower.includes('counsel') || lower.includes('barrister') || lower.includes('chambers')) {
      attendanceType = 'counsel_conference';
    } else if (lower.includes('meeting') || lower.includes('in person') || lower.includes('conference room')) {
      attendanceType = 'meeting';
    } else if (lower.includes('review') || lower.includes('drafting') || lower.includes('file review')) {
      attendanceType = 'file_review';
    }

    // 2. Detect duration heuristics (e.g. "30 mins", "45 minutes", "1 hour")
    let estimatedMinutes: number | null = null;
    const durationMatch = lower.match(/(\d+)\s*(?:mins?|minutes?|hr|hour)/);
    if (durationMatch?.[1]) {
      const val = parseInt(durationMatch[1], 10);
      if (lower.includes('hour') || lower.includes('hr')) {
        estimatedMinutes = val * 60;
      } else {
        estimatedMinutes = val;
      }
    }

    // 3. Extract action items (bullet points with todo, action, agreed, deadline)
    const actionItems: ActionItem[] = [];
    const dateRegex = /\b(\d{4}-\d{2}-\d{2}|\d{1,2}[/-]\d{1,2}[/-]\d{4})\b/;

    for (const line of lines) {
      const lineLower = line.toLowerCase();
      if (
        line.startsWith('- [ ]') ||
        line.startsWith('* [ ]') ||
        lineLower.startsWith('action:') ||
        lineLower.startsWith('agreed:') ||
        lineLower.startsWith('todo:') ||
        lineLower.startsWith('next steps:')
      ) {
        const cleaned = line
          .replace(/^[-*]\s*(\[[ x]\]\s*)?/i, '')
          .replace(/^(action|agreed|todo|next steps):\s*/i, '')
          .trim();

        if (cleaned.length > 0) {
          const dateMatch = cleaned.match(dateRegex);
          let dueOn: string | null = null;
          if (dateMatch?.[1]) {
            dueOn = dateMatch[1];
          }

          actionItems.push({
            taskTitle: cleaned.replace(/\bby\s+\d{4}-\d{2}-\d{2}\b/i, '').trim(),
            dueOn,
            priority: lineLower.includes('urgent') || lineLower.includes('asap') ? 'urgent' : 'normal',
          });
        }
      }
    }

    // If no explicit bullets were found, extract sentences that suggest actions
    if (actionItems.length === 0) {
      for (const line of lines) {
        if (/^(we will|i will|client to|solicitor to|instructed to)\b/i.test(line)) {
          actionItems.push({
            taskTitle: line,
            priority: 'normal',
          });
        }
      }
    }

    const today = new Date().toISOString().slice(0, 10);
    const date = context?.defaultDate || today;
    const feeEarner = context?.feeEarnerName || 'Fee Earner';
    const attendees = [feeEarner];
    if (context?.matterTitle) {
      attendees.push('Client');
    }

    return {
      matterTitle: context?.matterTitle,
      matterReference: context?.matterReference,
      date,
      time: null,
      attendanceType,
      attendees,
      feeEarner,
      synopsis: text,
      adviceGiven: 'Standard legal advice and procedural cautions tendered in accordance with instructions.',
      actionItems,
      estimatedMinutes,
    };
  }

  /**
   * Formats structured attendance note into formal UK law firm markdown document.
   */
  formatToMarkdown(note: AttendanceNoteStructured): string {
    const typeLabels: Record<AttendanceType, string> = {
      telephone: 'Telephone Attendance',
      meeting: 'In-Person Client / Counterparty Conference',
      court_hearing: 'Court Hearing Attendance',
      counsel_conference: 'Conference with Counsel',
      file_review: 'File & Document Review',
    };

    let md = '# ATTENDANCE NOTE\n\n';
    if (note.matterReference || note.matterTitle) {
      md += `**Matter**: ${[note.matterReference, note.matterTitle].filter(Boolean).join(' — ')}\n`;
    }
    md += `**Date**: ${note.date}${note.time ? ` at ${note.time}` : ''}\n`;
    md += `**Attendance Type**: ${typeLabels[note.attendanceType]}\n`;
    md += `**Fee Earner**: ${note.feeEarner}\n`;
    md += `**Attendees**: ${note.attendees.join(', ')}\n`;
    if (note.estimatedMinutes) {
      const units = Math.ceil(note.estimatedMinutes / 6);
      md += `**Duration**: ${note.estimatedMinutes} minutes (${units} units)\n`;
    }
    md += '\n---\n\n';

    md += '### 1. Synopsis of Attendance\n';
    md += `${note.synopsis.trim()}\n\n`;

    md += '### 2. Legal Advice Tendered\n';
    md += `${note.adviceGiven.trim()}\n\n`;

    md += '### 3. Agreed Action Items & Next Steps\n';
    if (note.actionItems.length === 0) {
      md += '- [ ] No urgent follow-up tasks required. File noted.\n';
    } else {
      for (const item of note.actionItems) {
        const due = item.dueOn ? ` (Due: ${item.dueOn})` : '';
        const prio = item.priority && item.priority !== 'normal' ? ` [${item.priority.toUpperCase()}]` : '';
        md += `- [ ] ${item.taskTitle}${due}${prio}\n`;
      }
    }

    md += '\n---\n';
    md += '_Attendance note recorded pursuant to SRA Code of Conduct supervisory standards._\n';

    return md;
  }
}
