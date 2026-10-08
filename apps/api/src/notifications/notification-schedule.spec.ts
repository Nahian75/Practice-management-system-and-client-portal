import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../config/env.js';
import { londonReminderSchedule, TaskReminderScheduler } from './notification-schedule.js';
import type { TaskReminderService } from './task-reminder.service.js';

describe('London reminder schedule', () => {
  it('waits until 09:00 on the same winter day', () => {
    expect(londonReminderSchedule(new Date('2026-01-12T08:30:00Z'))).toEqual({
      londonDate: '2026-01-12',
      runNow: false,
      nextRunAt: new Date('2026-01-12T09:00:00Z'),
    });
  });

  it('runs missed work on startup after 09:00 and schedules tomorrow', () => {
    expect(londonReminderSchedule(new Date('2026-01-12T12:00:00Z'))).toEqual({
      londonDate: '2026-01-12',
      runNow: true,
      nextRunAt: new Date('2026-01-13T09:00:00Z'),
    });
  });

  it('keeps 09:00 local when British Summer Time starts', () => {
    expect(londonReminderSchedule(new Date('2026-03-29T07:59:00Z'))).toEqual({
      londonDate: '2026-03-29',
      runNow: false,
      nextRunAt: new Date('2026-03-29T08:00:00Z'),
    });
  });

  it('keeps 09:00 local when British Summer Time ends', () => {
    expect(londonReminderSchedule(new Date('2026-10-25T08:59:00Z'))).toEqual({
      londonDate: '2026-10-25',
      runNow: false,
      nextRunAt: new Date('2026-10-25T09:00:00Z'),
    });
  });

  it('runs a missed batch on production startup after 09:00', async () => {
    const run = vi.fn(async () => 0);
    const scheduler = new TaskReminderScheduler(
      { run } as unknown as TaskReminderService,
      { now: () => new Date('2026-01-12T12:00:00Z') },
      { NODE_ENV: 'production' } as Env,
    );

    scheduler.onModuleInit();
    await vi.waitFor(() => expect(run).toHaveBeenCalledWith('2026-01-12'));
    await scheduler.onApplicationShutdown();
  });
});
