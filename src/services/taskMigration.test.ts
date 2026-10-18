import { seedTasks } from '../data/seedTasks';
import { migrateTask, type LegacyTask } from './taskMigration';
import { loadTasks, saveTasks, TASKS_STORAGE_KEY } from './taskStorage';

const legacyTask: LegacyTask = {
  id: 'legacy-1',
  title: 'Old task',
  description: 'Stored before the assignee refactor',
  status: 'Pending',
  priority: 'Low',
  assignee: 'John Smith',
  createdAt: '2026-01-01T00:00:00.000Z',
};

describe('assignee migration', () => {
  it('converts a legacy string assignee into { id, name }', () => {
    expect(migrateTask(legacyTask)).toEqual({
      ...legacyTask,
      assignee: { id: 'user-john-smith', name: 'John Smith' },
    });
  });

  it('derives the same id for the same name', () => {
    const again = migrateTask({ ...legacyTask, assignee: '  john smith ' });
    expect(again.assignee.id).toBe('user-john-smith');
  });

  it('leaves structured assignees untouched', () => {
    expect(migrateTask(seedTasks[0])).toBe(seedTasks[0]);
  });

  it('loads structured assignees from storage unchanged', () => {
    saveTasks(seedTasks);
    expect(loadTasks()).toEqual(seedTasks);
  });

  it('migrates legacy tasks when loading from storage', () => {
    localStorage.setItem(TASKS_STORAGE_KEY, JSON.stringify([legacyTask, seedTasks[0]]));
    expect(loadTasks()).toEqual([
      { ...legacyTask, assignee: { id: 'user-john-smith', name: 'John Smith' } },
      seedTasks[0],
    ]);
  });
});
