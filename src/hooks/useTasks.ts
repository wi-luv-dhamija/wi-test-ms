import { useCallback, useState } from 'react';
import { TaskService } from '../services/taskService';
import type { Task, TaskInput, TaskStatus } from '../types/task';

export function useTasks() {
  const [tasks, setTasks] = useState<Task[]>(() => TaskService.getAll());

  const addTask = useCallback((input: TaskInput) => {
    TaskService.create(input);
    setTasks(TaskService.getAll());
  }, []);

  const updateTask = useCallback((id: string, changes: Partial<TaskInput>) => {
    setTasks(TaskService.update(id, changes));
  }, []);

  const changeStatus = useCallback((id: string, status: TaskStatus) => {
    setTasks(TaskService.updateStatus(id, status));
  }, []);

  const deleteTask = useCallback((id: string) => {
    setTasks(TaskService.remove(id));
  }, []);

  return { tasks, addTask, updateTask, changeStatus, deleteTask };
}
