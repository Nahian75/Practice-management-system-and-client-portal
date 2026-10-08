import { Inject, Injectable, Logger, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import { CLOCK, type Clock } from '../common/time/clock.js';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import { TaskReminderService } from './task-reminder.service.js';

const LONDON = 'Europe/London';
const formatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: LONDON,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

interface CalendarParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

export interface LondonReminderSchedule {
  londonDate: string;
  runNow: boolean;
  nextRunAt: Date;
}

export function londonReminderSchedule(now: Date): LondonReminderSchedule {
  const local = parts(now);
  const runNow = local.hour >= 9;
  const target = addCalendarDays(local, runNow ? 1 : 0);
  return {
    londonDate: dateText(local),
    runNow,
    nextRunAt: londonTimeToUtc({ ...target, hour: 9, minute: 0, second: 0 }),
  };
}

@Injectable()
export class TaskReminderScheduler implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(TaskReminderScheduler.name);
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | undefined;
  private stopping = false;

  constructor(
    private readonly reminders: TaskReminderService,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ENV) private readonly env: Env,
  ) {}

  onModuleInit(): void {
    if (this.env.NODE_ENV === 'test') {
      return;
    }
    const schedule = londonReminderSchedule(this.clock.now());
    if (schedule.runNow) {
      this.run(schedule.londonDate);
    } else {
      this.schedule(schedule.nextRunAt);
    }
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopping = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    await this.running;
  }

  private run(londonDate: string): void {
    const running = this.reminders.run(londonDate)
      .catch(() => this.logger.error('Task reminder batch failed'))
      .then(() => undefined)
      .finally(() => {
        if (this.running === running) {
          this.running = undefined;
        }
        if (!this.stopping) {
          this.schedule(londonReminderSchedule(this.clock.now()).nextRunAt);
        }
      });
    this.running = running;
  }

  private schedule(at: Date): void {
    if (this.stopping) {
      return;
    }
    const delay = Math.max(0, at.getTime() - this.clock.now().getTime());
    this.timer = setTimeout(() => {
      const current = londonReminderSchedule(this.clock.now());
      this.run(current.londonDate);
    }, delay);
    this.timer.unref();
  }
}

function parts(value: Date): CalendarParts {
  const values = Object.fromEntries(
    formatter.formatToParts(value)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, Number(part.value)]),
  );
  return values as unknown as CalendarParts;
}

function addCalendarDays(value: CalendarParts, days: number): CalendarParts {
  const date = new Date(Date.UTC(value.year, value.month - 1, value.day + days));
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    hour: value.hour,
    minute: value.minute,
    second: value.second,
  };
}

function londonTimeToUtc(value: CalendarParts): Date {
  const wanted = Date.UTC(value.year, value.month - 1, value.day, value.hour, value.minute, value.second);
  let guess = wanted;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const seen = parts(new Date(guess));
    const seenAsUtc = Date.UTC(seen.year, seen.month - 1, seen.day, seen.hour, seen.minute, seen.second);
    guess += wanted - seenAsUtc;
  }
  return new Date(guess);
}

function dateText(value: Pick<CalendarParts, 'year' | 'month' | 'day'>): string {
  return `${value.year.toString().padStart(4, '0')}-${value.month.toString().padStart(2, '0')}-${value.day.toString().padStart(2, '0')}`;
}
