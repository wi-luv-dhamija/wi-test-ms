import { seedTasks } from '../data/seedTasks';
import { TaskService } from './taskService';
import { TASKS_STORAGE_KEY } from './taskStorage';

describe('TaskService', () => {
  it('seeds storage on first load', () => {
    expect(localStorage.getItem(TASKS_STORAGE_KEY)).toBeNull();
    expect(TaskService.getAll()).toEqual(seedTasks);
    expect(JSON.parse(localStorage.getItem(TASKS_STORAGE_KEY)!)).toEqual(seedTasks);
  });

  it('does not reseed after all tasks are deleted', () => {
    for (const t of seedTasks) TaskService.remove(t.id);
    expect(TaskService.getAll()).toEqual([]);
  });

  it('falls back to seed data when storage is corrupt', () => {
    localStorage.setItem(TASKS_STORAGE_KEY, '{not json');
    expect(TaskService.getAll()).toEqual(seedTasks);
  });

  it('creates, updates and removes tasks', () => {
    const task = TaskService.create({
      title: 'New',
      description: '',
      status: 'Pending',
      priority: 'Low',
      assignee: { id: 'user-sam', name: 'Sam' },
    });
    expect(TaskService.getAll()[0]).toEqual(task);

    TaskService.updateStatus(task.id, 'Completed');
    expect(TaskService.getAll()[0].status).toBe('Completed');

    TaskService.remove(task.id);
    expect(TaskService.getAll()).toHaveLength(seedTasks.length);
  });
});
