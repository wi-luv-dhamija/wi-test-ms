import type { Task } from '../types/task';
import { migrateTask } from './taskMigration';

export const TASKS_STORAGE_KEY = 'flowboard.tasks';

/** Returns stored tasks, or null if nothing has been stored yet (or the data is unreadable). */
export function loadTasks(): Task[] | null {
  try {
    const raw = localStorage.getItem(TASKS_STORAGE_KEY);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(migrateTask) : null;
  } catch {
    return null;
  }
}

export function saveTasks(tasks: Task[]): void {
  localStorage.setItem(TASKS_STORAGE_KEY, JSON.stringify(tasks));
}
