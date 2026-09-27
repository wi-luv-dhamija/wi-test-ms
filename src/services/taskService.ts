import { seedTasks } from '../data/seedTasks';
import type { Task, TaskInput, TaskStatus } from '../types/task';
import { loadTasks, saveTasks } from './taskStorage';

/** All task reads and writes go through here. Seeds storage on first access. */
export const TaskService = {
  getAll(): Task[] {
    const stored = loadTasks();
    if (stored) return stored;
    saveTasks(seedTasks);
    return seedTasks;
  },

  create(input: TaskInput): Task {
    const task: Task = { ...input, id: crypto.randomUUID(), createdAt: new Date().toISOString() };
    saveTasks([task, ...TaskService.getAll()]);
    return task;
  },

  update(id: string, changes: Partial<TaskInput>): Task[] {
    const tasks = TaskService.getAll().map((t) => (t.id === id ? { ...t, ...changes } : t));
    saveTasks(tasks);
    return tasks;
  },

  updateStatus(id: string, status: TaskStatus): Task[] {
    return TaskService.update(id, { status });
  },

  remove(id: string): Task[] {
    const tasks = TaskService.getAll().filter((t) => t.id !== id);
    saveTasks(tasks);
    return tasks;
  },
};
