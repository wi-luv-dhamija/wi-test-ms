import { useState } from 'react';
import { PriorityFilter } from '../components/PriorityFilter';
import { filterByPriority, type PriorityFilterValue } from '../utils/priorityFilter';
import { TaskCard } from '../components/TaskCard';
import { TaskForm } from '../components/TaskForm';
import { useTasks } from '../hooks/useTasks';
import type { Task } from '../types/task';
import styles from './TasksPage.module.css';

export function TasksPage() {
  const { tasks: allTasks, addTask, updateTask, changeStatus, deleteTask } = useTasks();
  const [priority, setPriority] = useState<PriorityFilterValue>('All');
  const tasks = filterByPriority(allTasks, priority);
  const [isCreating, setIsCreating] = useState(false);
  const [editing, setEditing] = useState<Task | null>(null);

  const closeForm = () => {
    setIsCreating(false);
    setEditing(null);
  };

  const controls = (
    <>
      <div className="page-header">
        <h1>Tasks</h1>
        {!isCreating && !editing && (
          <button type="button" className="btn btn-primary" onClick={() => setIsCreating(true)}>
            Add task
          </button>
        )}
      </div>

      <PriorityFilter value={priority} onChange={setPriority} />

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
    </>
  );

  if (allTasks.length > 0 && tasks.length === 0) {
    return (
      <>
        {controls}
        <p className="muted">No tasks found for this priority.</p>
      </>
    );
  }

  return (
    <>
      {controls}

      {tasks.length === 0 ? (
        <p className="muted">No tasks yet. Add one to get started.</p>
      ) : (
        <div className={styles.grid}>
          {tasks.map((task) => (
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
