import { Injectable } from '@nestjs/common';
import type { AuditActor } from '../audit/audit-event.js';
import { AuditService } from '../audit/audit.service.js';
import type { RequestContext } from '../common/http/request-context.js';
import type { Kysely } from 'kysely';
import type { Database, TaskPriority, TaskStatus } from '../database/schema.js';
import type { Task, TaskDetails } from './task.js';
import { TasksRepository } from './tasks.repository.js';

export const TASKS_PAGE_SIZE = 100;

export interface TaskActor {
  actor: AuditActor;
  accountId: string;
  context?: RequestContext;
}

export type CreateTaskResult =
  | { outcome: 'created'; task: Task }
  | { outcome: 'not_found' | 'not_open' | 'invalid_assignee' | 'changed_meanwhile' };

export type ChangeTaskResult =
  | { outcome: 'changed' | 'unchanged'; task: Task }
  | { outcome: 'not_found' | 'not_open' | 'invalid_assignee' | 'not_allowed' | 'invalid_transition' | 'changed_meanwhile' };

@Injectable()
export class TasksService {
  constructor(
    private readonly tasks: TasksRepository,
    private readonly audit: AuditService,
  ) {}

  async create(
    matterId: string,
    details: { title: string; description?: string | null; dueOn?: string | null; priority: TaskPriority; assigneeId: string },
    by: TaskActor,
  ): Promise<CreateTaskResult> {
    const matter = await this.tasks.matterOnTeam(matterId, by.accountId);
    if (!matter) {
      return { outcome: 'not_found' };
    }
    if (matter.status !== 'open') {
      return { outcome: 'not_open' };
    }
    if (!(await this.tasks.activeAssigneeOnTeam(matterId, details.assigneeId))) {
      return { outcome: 'invalid_assignee' };
    }

    try {
      const task = await this.tasks.transaction(async (trx) => {
        const taskId = await this.tasks.insert(
          {
            matterId,
            title: details.title,
            description: details.description ?? null,
            dueOn: details.dueOn ?? null,
            priority: details.priority,
            assigneeId: details.assigneeId,
            createdBy: by.accountId,
          },
          trx,
        );
        await this.audit.record(
          {
            actor: by.actor,
            action: 'task.created',
            outcome: 'success',
            resource: { type: 'task', id: taskId },
            metadata: { matterId, assigneeId: details.assigneeId, priority: details.priority, hasDueDate: details.dueOn != null },
            ...by.context,
          },
          trx,
        );
        return this.tasks.findVisible(taskId, by.accountId, trx);
      });
      if (!task) {
        return { outcome: 'changed_meanwhile' };
      }
      return { outcome: 'created', task };
    } catch (error) {
      if (isCheckViolation(error)) {
        return { outcome: 'changed_meanwhile' };
      }
      throw error;
    }
  }

  async list(matterId: string, viewerId: string, before?: string): Promise<{ tasks: Task[]; next: string | null } | undefined> {
    const tasks = await this.tasks.listForMatter(matterId, viewerId, { before, limit: TASKS_PAGE_SIZE });
    if (!tasks) {
      return undefined;
    }
    return { tasks, next: tasks.length === TASKS_PAGE_SIZE ? (tasks.at(-1)?.id ?? null) : null };
  }

  find(taskId: string, viewerId: string): Promise<TaskDetails | undefined> {
    return this.tasks.findDetails(taskId, viewerId);
  }

  edit(
    taskId: string,
    patch: { title?: string; description?: string | null; dueOn?: string | null; priority?: TaskPriority },
    by: TaskActor,
  ): Promise<ChangeTaskResult> {
    return this.change(taskId, by, async (current, trx) => {
      const target = {
        title: patch.title ?? current.title,
        description: patch.description !== undefined ? patch.description : current.description,
        dueOn: patch.dueOn !== undefined ? patch.dueOn : current.dueOn,
        priority: patch.priority ?? current.priority,
      };
      const change = await this.tasks.insertDetailsChange({ taskId, ...target, changedBy: by.accountId }, trx);
      if (!change) {
        return 'unchanged';
      }
      const fields = [
        ...(change.from_title !== change.to_title ? ['title'] : []),
        ...(change.from_description !== change.to_description ? ['description'] : []),
        ...(change.from_due_on !== change.to_due_on ? ['dueOn'] : []),
        ...(change.from_priority !== change.to_priority ? ['priority'] : []),
      ].sort();
      await this.recordChange('task.updated', taskId, current.matterId, { fields: fields.join(',') }, by, trx);
      return 'changed';
    });
  }

  reassign(taskId: string, assigneeId: string, by: TaskActor): Promise<ChangeTaskResult> {
    return this.change(taskId, by, async (current, trx) => {
      if (!(await this.tasks.activeAssigneeOnTeam(current.matterId, assigneeId, trx))) {
        return 'invalid_assignee';
      }
      const change = await this.tasks.insertAssignmentChange({ taskId, assigneeId, changedBy: by.accountId }, trx);
      if (!change) {
        return 'unchanged';
      }
      await this.recordChange(
        'task.reassigned',
        taskId,
        current.matterId,
        { fromAssigneeId: change.from_assigned_to!, toAssigneeId: change.to_assigned_to! },
        by,
        trx,
      );
      return 'changed';
    });
  }

  changeStatus(taskId: string, status: TaskStatus, by: TaskActor): Promise<ChangeTaskResult> {
    return this.change(taskId, by, async (current, trx) => {
      if (current.assignee.accountId !== by.accountId && !current.viewerSupervises) {
        return 'not_allowed';
      }
      if (current.status !== 'open' && status !== 'open' && current.status !== status) {
        return 'invalid_transition';
      }
      const change = await this.tasks.insertStatusChange({ taskId, status, changedBy: by.accountId }, trx);
      if (!change) {
        return 'unchanged';
      }
      const action = status === 'completed' ? 'task.completed' : status === 'cancelled' ? 'task.cancelled' : 'task.reopened';
      await this.recordChange(
        action,
        taskId,
        current.matterId,
        { fromStatus: change.from_status!, toStatus: change.to_status! },
        by,
        trx,
      );
      return 'changed';
    });
  }

  private async change(
    taskId: string,
    by: TaskActor,
    apply: (
      current: Awaited<ReturnType<TasksRepository['findForChange']>> & {},
      trx: Kysely<Database>,
    ) => Promise<'changed' | 'unchanged' | 'invalid_assignee' | 'not_allowed' | 'invalid_transition'>,
  ): Promise<ChangeTaskResult> {
    try {
      return await this.tasks.transaction(async (trx) => {
        const current = await this.tasks.findForChange(taskId, by.accountId, trx);
        if (!current) {
          return { outcome: 'not_found' };
        }
        if (current.matterStatus !== 'open') {
          return { outcome: 'not_open' };
        }
        const outcome = await apply(current, trx);
        if (outcome === 'invalid_assignee' || outcome === 'not_allowed' || outcome === 'invalid_transition') {
          return { outcome };
        }
        const task = await this.tasks.findVisible(taskId, by.accountId, trx);
        if (!task) {
          return { outcome: 'changed_meanwhile' };
        }
        return { outcome, task };
      });
    } catch (error) {
      if (isCheckViolation(error)) {
        return { outcome: 'changed_meanwhile' };
      }
      throw error;
    }
  }

  private recordChange(
    action: string,
    taskId: string,
    matterId: string,
    metadata: Record<string, string>,
    by: TaskActor,
    trx: Kysely<Database>,
  ) {
    return this.audit.record(
      {
        actor: by.actor,
        action,
        outcome: 'success',
        resource: { type: 'task', id: taskId },
        metadata: { matterId, ...metadata },
        ...by.context,
      },
      trx,
    );
  }
}

function isCheckViolation(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === '23514';
}
