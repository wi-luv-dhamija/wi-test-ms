import { useState } from 'react';
import { TaskCard } from '../components/TaskCard';
import { TaskForm } from '../components/TaskForm';
import { TaskSearch } from '../components/TaskSearch';
import { useTasks } from '../hooks/useTasks';
import type { Task } from '../types/task';
import { searchTasks } from '../utils/taskSearch';
import styles from './TasksPage.module.css';

export function TasksPage() {
  const { tasks, addTask, updateTask, changeStatus, deleteTask } = useTasks();
  const [isCreating, setIsCreating] = useState(false);
  const [editing, setEditing] = useState<Task | null>(null);
  const [query, setQuery] = useState('');
  const visibleTasks = searchTasks(tasks, query);

  const closeForm = () => {
    setIsCreating(false);
    setEditing(null);
  };

  return (
    <>
      <div className="page-header">
        <h1>Tasks</h1>
        {!isCreating && !editing && (
          <button type="button" className="btn btn-primary" onClick={() => setIsCreating(true)}>
            Add task
          </button>
        )}
      </div>

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

      <TaskSearch value={query} onChange={setQuery} />

      {tasks.length === 0 ? (
        <p className="muted">No tasks yet. Add one to get started.</p>
      ) : visibleTasks.length === 0 ? (
        <p className="muted">No tasks match your search.</p>
      ) : (
        <div className={styles.grid}>
          {visibleTasks.map((task) => (
            <TaskCard
              key={task.id}
              task={task}
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
