import { Inject, Injectable } from '@nestjs/common';
import type { Kysely, Selectable } from 'kysely';
import { DATABASE } from '../database/database.module.js';
import type { Database, MatterStatus, TaskChangesTable, TaskPriority, TaskStatus } from '../database/schema.js';
import { visibleTo } from '../matters/matters.repository.js';
import type { NewTask, Task, TaskChange, TaskDetails } from './task.js';

type TaskRow = {
  id: string;
  matter_id: string;
  title: string;
  description: string | null;
  due_on: string | null;
  priority: Task['priority'];
  status: Task['status'];
  assigned_to: string;
  assignee_name: string;
  created_by: string;
  creator_name: string;
  created_at: Date;
};

type TaskChangeRow = Selectable<TaskChangesTable> & {
  changed_by_name: string;
  from_assignee_name: string | null;
  to_assignee_name: string | null;
};

export interface TaskForChange extends Task {
  matterStatus: MatterStatus;
  viewerSupervises: boolean;
}

@Injectable()
export class TasksRepository {
  constructor(@Inject(DATABASE) private readonly db: Kysely<Database>) {}

  transaction<T>(work: (trx: Kysely<Database>) => Promise<T>): Promise<T> {
    return this.db.transaction().execute(work);
  }

  /** The matter's state if the viewer is still on its team. */
  matterOnTeam(matterId: string, viewerId: string): Promise<{ status: MatterStatus } | undefined> {
    return this.db.selectFrom('matters').select('status').where('id', '=', matterId).where(visibleTo(viewerId)).executeTakeFirst();
  }

  /** The assignee must be active staff and still on this matter's team. */
  async activeAssigneeOnTeam(matterId: string, accountId: string, executor: Kysely<Database> = this.db): Promise<boolean> {
    const row = await executor
      .selectFrom('matter_team')
      .innerJoin('accounts', 'accounts.id', 'matter_team.account_id')
      .select('matter_team.id')
      .where('matter_team.matter_id', '=', matterId)
      .where('matter_team.account_id', '=', accountId)
      .where('matter_team.removed_at', 'is', null)
      .where('accounts.kind', '=', 'staff')
      .where('accounts.status', '=', 'active')
      .executeTakeFirst();
    return row !== undefined;
  }

  /** The database rechecks matter state and both team memberships during this insert. */
  async insert(task: NewTask, trx: Kysely<Database>): Promise<string> {
    const row = await trx
      .insertInto('tasks')
      .values({
        matter_id: task.matterId,
        title: task.title,
        description: task.description,
        due_on: task.dueOn,
        priority: task.priority,
        assigned_to: task.assigneeId,
        created_by: task.createdBy,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return row.id;
  }

  /** One page, newest first. The task query itself repeats the team filter. */
  async listForMatter(matterId: string, viewerId: string, page: { before?: string; limit: number }): Promise<Task[] | undefined> {
    if (!(await this.matterOnTeam(matterId, viewerId))) {
      return undefined;
    }
    const rows = await this.rows(this.db)
      .where('tasks.matter_id', '=', matterId)
      .where(visibleTo(viewerId))
      .$if(page.before !== undefined, (query) => query.where('tasks.id', '<', page.before as string))
      .orderBy('tasks.id', 'desc')
      .limit(page.limit)
      .execute();
    return rows.map(toTask);
  }

  /** A task only when the viewer is still on its matter's team. */
  async findVisible(taskId: string, viewerId: string, executor: Kysely<Database> = this.db): Promise<Task | undefined> {
    const row = await this.rows(executor).where('tasks.id', '=', taskId).where(visibleTo(viewerId)).executeTakeFirst();
    return row ? toTask(row) : undefined;
  }

  async findDetails(taskId: string, viewerId: string): Promise<TaskDetails | undefined> {
    const task = await this.findVisible(taskId, viewerId);
    if (!task) {
      return undefined;
    }
    const rows = await this.db
      .selectFrom('task_changes')
      .innerJoin('tasks', 'tasks.id', 'task_changes.task_id')
      .innerJoin('matters', 'matters.id', 'tasks.matter_id')
      .innerJoin('accounts as changed_by_account', 'changed_by_account.id', 'task_changes.changed_by')
      .leftJoin('accounts as from_assignee', 'from_assignee.id', 'task_changes.from_assigned_to')
      .leftJoin('accounts as to_assignee', 'to_assignee.id', 'task_changes.to_assigned_to')
      .selectAll('task_changes')
      .select([
        'changed_by_account.display_name as changed_by_name',
        'from_assignee.display_name as from_assignee_name',
        'to_assignee.display_name as to_assignee_name',
      ])
      .where('task_changes.task_id', '=', taskId)
      .where(visibleTo(viewerId))
      .orderBy('task_changes.id')
      .execute();
    return { ...task, changes: rows.map(toTaskChange) };
  }

  /** Current state needed for a change, only if the viewer is on the task's matter team. */
  async findForChange(taskId: string, viewerId: string, executor: Kysely<Database>): Promise<TaskForChange | undefined> {
    const row = await this.rows(executor)
      .select(['matters.status as matter_status'])
      .select((eb) =>
        eb
          .exists(
            eb
              .selectFrom('matter_team')
              .select('matter_team.id')
              .whereRef('matter_team.matter_id', '=', 'tasks.matter_id')
              .where('matter_team.account_id', '=', viewerId)
              .where('matter_team.role', '=', 'supervising_partner')
              .where('matter_team.removed_at', 'is', null),
          )
          .as('viewer_supervises'),
      )
      .where('tasks.id', '=', taskId)
      .where(visibleTo(viewerId))
      .executeTakeFirst();
    return row ? { ...toTask(row), matterStatus: row.matter_status, viewerSupervises: Boolean(row.viewer_supervises) } : undefined;
  }

  insertDetailsChange(
    change: { taskId: string; title: string; description: string | null; dueOn: string | null; priority: TaskPriority; changedBy: string },
    trx: Kysely<Database>,
  ) {
    return this.insertChange(
      {
        task_id: change.taskId,
        kind: 'details',
        to_title: change.title,
        to_description: change.description,
        to_due_on: change.dueOn,
        to_priority: change.priority,
        to_assigned_to: null,
        to_status: null,
        changed_by: change.changedBy,
      },
      trx,
    );
  }

  insertAssignmentChange(change: { taskId: string; assigneeId: string; changedBy: string }, trx: Kysely<Database>) {
    return this.insertChange(
      {
        task_id: change.taskId,
        kind: 'assignment',
        to_title: null,
        to_description: null,
        to_due_on: null,
        to_priority: null,
        to_assigned_to: change.assigneeId,
        to_status: null,
        changed_by: change.changedBy,
      },
      trx,
    );
  }

  insertStatusChange(change: { taskId: string; status: TaskStatus; changedBy: string }, trx: Kysely<Database>) {
    return this.insertChange(
      {
        task_id: change.taskId,
        kind: 'status',
        to_title: null,
        to_description: null,
        to_due_on: null,
        to_priority: null,
        to_assigned_to: null,
        to_status: change.status,
        changed_by: change.changedBy,
      },
      trx,
    );
  }

  private insertChange(
    change: {
      task_id: string;
      kind: 'details' | 'assignment' | 'status';
      to_title: string | null;
      to_description: string | null;
      to_due_on: string | null;
      to_priority: TaskPriority | null;
      to_assigned_to: string | null;
      to_status: TaskStatus | null;
      changed_by: string;
    },
    trx: Kysely<Database>,
  ) {
    return trx
      .insertInto('task_changes')
      .values(change)
      .returning([
        'id',
        'from_title',
        'to_title',
        'from_description',
        'to_description',
        'from_due_on',
        'to_due_on',
        'from_priority',
        'to_priority',
        'from_assigned_to',
        'to_assigned_to',
        'from_status',
        'to_status',
      ])
      .executeTakeFirst();
  }

  private rows(executor: Kysely<Database>) {
    return executor
      .selectFrom('tasks')
      .innerJoin('matters', 'matters.id', 'tasks.matter_id')
      .innerJoin('accounts as assignee', 'assignee.id', 'tasks.assigned_to')
      .innerJoin('accounts as creator', 'creator.id', 'tasks.created_by')
      .select([
        'tasks.id',
        'tasks.matter_id',
        'tasks.title',
        'tasks.description',
        'tasks.due_on',
        'tasks.priority',
        'tasks.status',
        'tasks.assigned_to',
        'assignee.display_name as assignee_name',
        'tasks.created_by',
        'creator.display_name as creator_name',
        'tasks.created_at',
      ]);
  }
}

function toTask(row: TaskRow): Task {
  return {
    id: row.id,
    matterId: row.matter_id,
    title: row.title,
    description: row.description,
    dueOn: row.due_on,
    priority: row.priority,
    status: row.status,
    assignee: { accountId: row.assigned_to, displayName: row.assignee_name },
    createdBy: { accountId: row.created_by, displayName: row.creator_name },
    createdAt: row.created_at,
  };
}

function toTaskChange(row: TaskChangeRow): TaskChange {
  const common = {
    id: row.id,
    changedBy: { accountId: row.changed_by, displayName: row.changed_by_name },
    changedAt: row.changed_at,
  };
  switch (row.kind) {
    case 'details':
      return {
        ...common,
        kind: 'details',
        from: { title: row.from_title!, description: row.from_description, dueOn: row.from_due_on, priority: row.from_priority! },
        to: { title: row.to_title!, description: row.to_description, dueOn: row.to_due_on, priority: row.to_priority! },
      };
    case 'assignment':
      return {
        ...common,
        kind: 'assignment',
        from: { accountId: row.from_assigned_to!, displayName: row.from_assignee_name! },
        to: { accountId: row.to_assigned_to!, displayName: row.to_assignee_name! },
      };
    case 'status':
      return { ...common, kind: 'status', from: row.from_status!, to: row.to_status! };
  }
}
