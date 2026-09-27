import type { Task } from '../types/task';

export interface TaskStats {
  total: number;
  completed: number;
  inProgress: number;
  pending: number;
}

export function getTaskStats(tasks: Task[]): TaskStats {
  return {
    total: tasks.length,
    completed: tasks.filter((t) => t.status === 'Completed').length,
    inProgress: tasks.filter((t) => t.status === 'In Progress').length,
    pending: tasks.filter((t) => t.status === 'Pending').length,
  };
}

export function getRecentTasks(tasks: Task[], limit = 5): Task[] {
  return [...tasks].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
}
