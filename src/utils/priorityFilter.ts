import { TASK_PRIORITIES, type Task } from '../types/task';

export const PRIORITY_FILTER_OPTIONS = ['All', ...TASK_PRIORITIES] as const;
export type PriorityFilterValue = (typeof PRIORITY_FILTER_OPTIONS)[number];

export function filterByPriority(tasks: Task[], priority: PriorityFilterValue): Task[] {
  return priority === 'All' ? tasks : tasks.filter((t) => t.priority === priority);
}
