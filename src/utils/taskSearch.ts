import type { Task } from '../types/task';

/** Case-insensitive match on title, description and assignee. Empty query returns all tasks. */
export function searchTasks(tasks: Task[], query: string): Task[] {
  const q = query.trim().toLowerCase();
  if (!q) return tasks;
  return tasks.filter((t) =>
    [t.title, t.description, t.assignee].some((field) => field.toLowerCase().includes(q)),
  );
}
