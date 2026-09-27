export const TASK_STATUSES = ['Pending', 'In Progress', 'Completed'] as const;
export const TASK_PRIORITIES = ['Low', 'Medium', 'High'] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

export interface Task {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  assignee: string;
  createdAt: string; // ISO 8601
}

/** Fields a user can supply when creating or editing a task. */
export type TaskInput = Omit<Task, 'id' | 'createdAt'>;
