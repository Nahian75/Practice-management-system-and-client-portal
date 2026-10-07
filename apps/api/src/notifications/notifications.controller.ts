import { Controller, Get, HttpCode, HttpStatus, NotFoundException, Param, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { auditActorFor, CurrentSession, type ResolvedSession } from '../auth/sessions/authenticated-session.js';
import { StaffOnly } from '../auth/sessions/access.decorators.js';
import { requestContext } from '../common/http/request-context.js';
import { NO_CONTENT, ResponseSchema } from '../common/serialization/response-schema.decorator.js';
import { NotificationsService } from './notifications.service.js';

const kinds = [
  'task_assigned',
  'task_unassigned',
  'task_completed',
  'task_cancelled',
  'task_reopened',
  'task_due_soon',
  'task_due_today',
  'task_overdue',
] as const;
const listQuerySchema = z.strictObject({ before: z.uuid().optional() });
const notificationSchema = z.object({
  id: z.uuid(),
  kind: z.enum(kinds),
  createdAt: z.iso.datetime(),
  readAt: z.iso.datetime().nullable(),
  task: z.object({
    id: z.uuid(),
    title: z.string(),
    status: z.enum(['open', 'completed', 'cancelled']),
    dueOn: z.iso.date().nullable(),
  }),
});
const listSchema = z.object({
  notifications: z.array(notificationSchema),
  next: z.uuid().nullable(),
  unreadCount: z.number().int().nonnegative(),
});

@Controller('notifications')
@StaffOnly()
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  @ResponseSchema(listSchema)
  async list(
    @Query({ schema: listQuerySchema }) query: z.infer<typeof listQuerySchema>,
    @CurrentSession() session: ResolvedSession,
  ) {
    const page = await this.notifications.list(session.account.id, query.before);
    return {
      ...page,
      notifications: page.notifications.map((notification) => ({
        ...notification,
        createdAt: notification.createdAt.toISOString(),
        readAt: notification.readAt?.toISOString() ?? null,
      })),
    };
  }

  @Post(':id/read')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ResponseSchema(NO_CONTENT)
  async read(
    @Param('id', { schema: z.uuid() }) id: string,
    @CurrentSession() session: ResolvedSession,
    @Req() request: Request,
  ): Promise<void> {
    const found = await this.notifications.read(id, {
      actor: auditActorFor(session.account),
      accountId: session.account.id,
      context: requestContext(request),
    });
    if (!found) {
      throw new NotFoundException('No notification with this id');
    }
  }
}
