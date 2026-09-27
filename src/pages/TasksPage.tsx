import { useState } from 'react';
import { TaskCard } from '../components/TaskCard';
import { TaskForm } from '../components/TaskForm';
import { TaskToolbar, type TaskViewMode } from '../components/TaskToolbar';
import { useTasks } from '../hooks/useTasks';
import type { Task } from '../types/task';
import styles from './TasksPage.module.css';

export function TasksPage() {
  const { tasks, addTask, updateTask, changeStatus, deleteTask } = useTasks();
  const [isCreating, setIsCreating] = useState(false);
  const [editing, setEditing] = useState<Task | null>(null);
  const [viewMode, setViewMode] = useState<TaskViewMode>('grid');

  const closeForm = () => {
    setIsCreating(false);
    setEditing(null);
  };

  return (
    <>
      <TaskToolbar
        viewMode={viewMode}
        onViewModeChange={setViewMode}
        canAddTask={!isCreating && !editing}
        onAddTask={() => setIsCreating(true)}
      />

      {isCreating && (
        <TaskForm
          submitLabel="Create task"
          onSubmit={(input) => {
            addTask(input);
            closeForm();
          }}
          onCancel={closeForm}
        />
      )}

      {editing && (
        <TaskForm
          key={editing.id}
          initialValues={editing}
          submitLabel="Save changes"
          onSubmit={(input) => {
            updateTask(editing.id, input);
            closeForm();
          }}
          onCancel={closeForm}
        />
      )}

      {tasks.length === 0 ? (
        <p className="muted">No tasks yet. Add one to get started.</p>
      ) : (
        <div
          className={viewMode === 'grid' ? styles.grid : styles.list}
          data-testid="task-collection"
          data-view={viewMode}
        >
          {tasks.map((task) => (
            <TaskCard
              key={task.id}
              task={task}
              compact={viewMode === 'list'}
              onStatusChange={changeStatus}
              onEdit={(t) => {
                setIsCreating(false);
                setEditing(t);
              }}
              onDelete={deleteTask}
            />
          ))}
        </div>
      )}
    </>
  );
}
