import { Body, ConflictException, Controller, ForbiddenException, Get, HttpCode, HttpStatus, NotFoundException, Param, Patch, Post, Put, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { RequirePermission } from '../auth/permissions/require-permission.decorator.js';
import { auditActorFor, CurrentSession, type ResolvedSession } from '../auth/sessions/authenticated-session.js';
import { requestContext } from '../common/http/request-context.js';
import { NO_CONTENT, ResponseSchema } from '../common/serialization/response-schema.decorator.js';
import { text } from '../common/validation/safe-text.js';
import type { Task } from './task.js';
import { TasksService, type ChangeTaskResult, type TaskActor } from './tasks.service.js';

const PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
const STATUSES = ['open', 'completed', 'cancelled'] as const;
const dueDate = z.iso.date().refine((value) => value >= '1900-01-01' && value <= '9999-12-31', 'Date is outside the supported range');
const createSchema = z.strictObject({
  title: text(200),
  description: text(2_000).nullable().optional(),
  dueOn: dueDate.nullable().optional(),
  priority: z.enum(PRIORITIES).default('normal'),
  assigneeId: z.uuid(),
});
const personSchema = z.object({ accountId: z.uuid(), displayName: z.string() });
const taskSchema = z.object({
  id: z.uuid(),
  matterId: z.uuid(),
  title: z.string(),
  description: z.string().nullable(),
  dueOn: z.iso.date().nullable(),
  priority: z.enum(PRIORITIES),
  status: z.enum(STATUSES),
  assignee: personSchema,
  createdBy: personSchema,
  createdAt: z.iso.datetime(),
});
const changeCommonSchema = { id: z.uuid(), changedBy: personSchema, changedAt: z.iso.datetime() };
const taskChangeSchema = z.discriminatedUnion('kind', [
  z.object({
    ...changeCommonSchema,
    kind: z.literal('details'),
    from: z.object({ title: z.string(), description: z.string().nullable(), dueOn: z.iso.date().nullable(), priority: z.enum(PRIORITIES) }),
    to: z.object({ title: z.string(), description: z.string().nullable(), dueOn: z.iso.date().nullable(), priority: z.enum(PRIORITIES) }),
  }),
  z.object({ ...changeCommonSchema, kind: z.literal('assignment'), from: personSchema, to: personSchema }),
  z.object({ ...changeCommonSchema, kind: z.literal('status'), from: z.enum(STATUSES), to: z.enum(STATUSES) }),
]);
const detailsSchema = taskSchema.extend({ changes: z.array(taskChangeSchema) });
const listQuerySchema = z.strictObject({ before: z.uuid().optional() });
const listSchema = z.object({ tasks: z.array(taskSchema), next: z.uuid().nullable() });
const editSchema = z
  .strictObject({
    title: text(200).optional(),
    description: text(2_000).nullable().optional(),
    dueOn: dueDate.nullable().optional(),
    priority: z.enum(PRIORITIES).optional(),
  })
  .refine((value) => Object.values(value).some((field) => field !== undefined), 'Give at least one field to change');
const assignmentSchema = z.strictObject({ assigneeId: z.uuid() });

function actorFor(session: ResolvedSession, request: Request): TaskActor {
  return { actor: auditActorFor(session.account), accountId: session.account.id, context: requestContext(request) };
}

function responseTask(task: Task) {
  return { ...task, createdAt: task.createdAt.toISOString() };
}

@Controller()
export class TasksController {
  constructor(private readonly tasks: TasksService) {}

  @Post('matters/:matterId/tasks')
  @RequirePermission('tasks.create')
  @ResponseSchema(taskSchema)
  async create(
    @Param('matterId', { schema: z.uuid() }) matterId: string,
    @Body({ schema: createSchema }) body: z.infer<typeof createSchema>,
    @CurrentSession() session: ResolvedSession,
    @Req() request: Request,
  ) {
    const result = await this.tasks.create(matterId, body, actorFor(session, request));
    switch (result.outcome) {
      case 'not_found':
        throw new NotFoundException('No matter with this id');
      case 'not_open':
        throw new ConflictException('Tasks are created only on open matters');
      case 'invalid_assignee':
        throw new ConflictException('The assignee is no longer an active member of this matter team');
      case 'changed_meanwhile':
        throw new ConflictException('The matter, team or assignee changed meanwhile. Reload and try again');
      case 'created':
        return responseTask(result.task);
    }
  }

  @Get('matters/:matterId/tasks')
  @RequirePermission('tasks.view')
  @ResponseSchema(listSchema)
  async list(
    @Param('matterId', { schema: z.uuid() }) matterId: string,
    @Query({ schema: listQuerySchema }) query: z.infer<typeof listQuerySchema>,
    @CurrentSession() session: ResolvedSession,
  ) {
    const page = await this.tasks.list(matterId, session.account.id, query.before);
    if (!page) {
      throw new NotFoundException('No matter with this id');
    }
    return { tasks: page.tasks.map(responseTask), next: page.next };
  }

  @Get('tasks/:taskId')
  @RequirePermission('tasks.view')
  @ResponseSchema(detailsSchema)
  async find(@Param('taskId', { schema: z.uuid() }) taskId: string, @CurrentSession() session: ResolvedSession) {
    const task = await this.tasks.find(taskId, session.account.id);
    if (!task) {
      throw new NotFoundException('No task with this id');
    }
    return { ...responseTask(task), changes: task.changes.map((change) => ({ ...change, changedAt: change.changedAt.toISOString() })) };
  }

  @Patch('tasks/:taskId')
  @RequirePermission('tasks.manage')
  @ResponseSchema(taskSchema)
  async edit(
    @Param('taskId', { schema: z.uuid() }) taskId: string,
    @Body({ schema: editSchema }) body: z.infer<typeof editSchema>,
    @CurrentSession() session: ResolvedSession,
    @Req() request: Request,
  ) {
    return this.changed(await this.tasks.edit(taskId, body, actorFor(session, request)));
  }

  @Put('tasks/:taskId/assignee')
  @RequirePermission('tasks.manage')
  @ResponseSchema(taskSchema)
  async reassign(
    @Param('taskId', { schema: z.uuid() }) taskId: string,
    @Body({ schema: assignmentSchema }) body: z.infer<typeof assignmentSchema>,
    @CurrentSession() session: ResolvedSession,
    @Req() request: Request,
  ) {
    return this.changed(await this.tasks.reassign(taskId, body.assigneeId, actorFor(session, request)));
  }

  @Post('tasks/:taskId/complete')
  @RequirePermission('tasks.manage')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ResponseSchema(NO_CONTENT)
  async complete(
    @Param('taskId', { schema: z.uuid() }) taskId: string,
    @CurrentSession() session: ResolvedSession,
    @Req() request: Request,
  ): Promise<void> {
    this.changed(await this.tasks.changeStatus(taskId, 'completed', actorFor(session, request)));
  }

  @Post('tasks/:taskId/cancel')
  @RequirePermission('tasks.manage')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ResponseSchema(NO_CONTENT)
  async cancel(
    @Param('taskId', { schema: z.uuid() }) taskId: string,
    @CurrentSession() session: ResolvedSession,
    @Req() request: Request,
  ): Promise<void> {
    this.changed(await this.tasks.changeStatus(taskId, 'cancelled', actorFor(session, request)));
  }

  @Post('tasks/:taskId/reopen')
  @RequirePermission('tasks.manage')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ResponseSchema(NO_CONTENT)
  async reopen(
    @Param('taskId', { schema: z.uuid() }) taskId: string,
    @CurrentSession() session: ResolvedSession,
    @Req() request: Request,
  ): Promise<void> {
    this.changed(await this.tasks.changeStatus(taskId, 'open', actorFor(session, request)));
  }

  private changed(result: ChangeTaskResult) {
    switch (result.outcome) {
      case 'not_found':
        throw new NotFoundException('No task with this id');
      case 'not_open':
        throw new ConflictException('Tasks can be changed only on open matters');
      case 'invalid_assignee':
        throw new ConflictException('The assignee is no longer an active member of this matter team');
      case 'not_allowed':
        throw new ForbiddenException("Only the task's assignee or the matter's supervising partner can change its status");
      case 'invalid_transition':
        throw new ConflictException('Reopen the task before changing it to another final status');
      case 'changed_meanwhile':
        throw new ConflictException('The task, matter or team changed meanwhile. Reload and try again');
      case 'changed':
      case 'unchanged':
        return responseTask(result.task);
    }
  }
}
