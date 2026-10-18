import type { Task } from '../types/task';
import { createAssignee } from '../utils/assignee';

/** Task shape stored before `assignee` became `{ id, name }`. */
export type LegacyTask = Omit<Task, 'assignee'> & { assignee: string };

/** Upgrades a task read from storage to the current shape. */
export function migrateTask(stored: Task | LegacyTask): Task {
  return typeof stored.assignee === 'string'
    ? { ...stored, assignee: createAssignee(stored.assignee) }
    : (stored as Task);
}
