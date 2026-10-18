import { useState, type FormEvent } from 'react';
import { TASK_PRIORITIES, TASK_STATUSES, type TaskInput } from '../types/task';
import { createAssignee } from '../utils/assignee';
import styles from './TaskForm.module.css';

const emptyTask: TaskInput = {
  title: '',
  description: '',
  status: 'Pending',
  priority: 'Medium',
  assignee: { id: '', name: '' },
};

interface TaskFormProps {
  initialValues?: TaskInput;
  submitLabel: string;
  onSubmit: (input: TaskInput) => void;
  onCancel: () => void;
}

export function TaskForm({
  initialValues = emptyTask,
  submitLabel,
  onSubmit,
  onCancel,
}: TaskFormProps) {
  const [values, setValues] = useState<TaskInput>(initialValues);

  const set = <K extends keyof TaskInput>(key: K, value: TaskInput[K]) =>
    setValues((v) => ({ ...v, [key]: value }));

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    const title = values.title.trim();
    const assigneeName = values.assignee.name.trim();
    if (!title || !assigneeName) return;
    onSubmit({
      ...values,
      title,
      description: values.description.trim(),
      // Keep the existing assignee (and its id) unless the name was changed.
      assignee:
        assigneeName === initialValues.assignee.name
          ? initialValues.assignee
          : createAssignee(assigneeName),
    });
  };

  return (
    <form className={styles.form} onSubmit={handleSubmit} aria-label="Task form">
      <label className={`${styles.field} ${styles.full}`}>
        Title
        <input required value={values.title} onChange={(e) => set('title', e.target.value)} />
      </label>
      <label className={`${styles.field} ${styles.full}`}>
        Description
        <textarea
          rows={3}
          value={values.description}
          onChange={(e) => set('description', e.target.value)}
        />
      </label>
      <label className={styles.field}>
        Status
        <select
          value={values.status}
          onChange={(e) => set('status', e.target.value as TaskInput['status'])}
        >
          {TASK_STATUSES.map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>
      </label>
      <label className={styles.field}>
        Priority
        <select
          value={values.priority}
          onChange={(e) => set('priority', e.target.value as TaskInput['priority'])}
        >
          {TASK_PRIORITIES.map((p) => (
            <option key={p}>{p}</option>
          ))}
        </select>
      </label>
      <label className={styles.field}>
        Assignee
        <input
          required
          value={values.assignee.name}
          onChange={(e) => set('assignee', { ...values.assignee, name: e.target.value })}
        />
      </label>
      <div className={styles.actions}>
        <button type="button" className="btn" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="btn btn-primary">
          {submitLabel}
        </button>
      </div>
    </form>
  );
}
