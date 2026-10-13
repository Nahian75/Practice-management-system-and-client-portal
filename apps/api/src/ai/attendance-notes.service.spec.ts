import { describe, expect, it } from 'vitest';
import { AttendanceNotesService } from './attendance-notes.service.js';

describe('AttendanceNotesService (Step 18d)', () => {
  const service = new AttendanceNotesService();

  it('structures telephone attendance notes with action items and duration', () => {
    const raw = `
Spoke with client on phone for 30 mins.
Discussion about counterparty settlement proposal of £35,000.
Client instructed that this is unacceptable and wishes to make counter-proposal of £48,000.
Action: Draft counter-offer letter by 2026-10-20.
Todo: Chase expert medical report asap.
    `;

    const structured = service.structureRawNotes(raw, {
      matterTitle: 'Smith v Jones',
      matterReference: 'C-000123/001',
      feeEarnerName: 'Partner User',
    });

    expect(structured.attendanceType).toBe('telephone');
    expect(structured.estimatedMinutes).toBe(30);
    expect(structured.attendees).toContain('Partner User');
    expect(structured.attendees).toContain('Client');
    expect(structured.actionItems.length).toBeGreaterThanOrEqual(2);
    expect(structured.actionItems[0]?.taskTitle).toContain('Draft counter-offer letter');
    expect(structured.actionItems[0]?.dueOn).toBe('2026-10-20');
    expect(structured.actionItems[1]?.priority).toBe('urgent');
  });

  it('detects court hearing attendance from keywords', () => {
    const raw = 'Attended Central London County Court hearing before HHJ Miller.';
    const structured = service.structureRawNotes(raw);
    expect(structured.attendanceType).toBe('court_hearing');
  });

  it('formats structured attendance note into formal legal markdown document', () => {
    const structured = {
      matterTitle: 'Commercial Lease Dispute',
      matterReference: 'M-7890',
      date: '2026-10-14',
      time: '11:00',
      attendanceType: 'telephone' as const,
      attendees: ['Partner User', 'Client'],
      feeEarner: 'Partner User',
      synopsis: 'Client confirmed receipt of breach notice.',
      adviceGiven: 'Advised client on 28-day statutory response window.',
      actionItems: [
        {
          taskTitle: 'File acknowledgment of service',
          dueOn: '2026-11-01',
          priority: 'urgent' as const,
        },
      ],
      estimatedMinutes: 24,
    };

    const md = service.formatToMarkdown(structured);
    expect(md).toContain('# ATTENDANCE NOTE');
    expect(md).toContain('**Matter**: M-7890 — Commercial Lease Dispute');
    expect(md).toContain('**Attendance Type**: Telephone Attendance');
    expect(md).toContain('**Duration**: 24 minutes (4 units)');
    expect(md).toContain('### 1. Synopsis of Attendance');
    expect(md).toContain('### 2. Legal Advice Tendered');
    expect(md).toContain('### 3. Agreed Action Items & Next Steps');
    expect(md).toContain('- [ ] File acknowledgment of service (Due: 2026-11-01) [URGENT]');
    expect(md).toContain('SRA Code of Conduct');
  });
});
