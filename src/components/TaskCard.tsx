import { TASK_STATUSES, type Task, type TaskStatus } from '../types/task';
import { formatDate } from '../utils/date';
import { StatusBadge } from './StatusBadge';
import styles from './TaskCard.module.css';

interface TaskCardProps {
  task: Task;
  onStatusChange: (id: string, status: TaskStatus) => void;
  onEdit: (task: Task) => void;
  onDelete: (id: string) => void;
}

export function TaskCard({ task, onStatusChange, onEdit, onDelete }: TaskCardProps) {
  return (
    <article className={styles.card} aria-label={task.title}>
      <div className={styles.top}>
        <h3 className={styles.title}>{task.title}</h3>
        <StatusBadge status={task.status} />
      </div>
      <p className={styles.description}>{task.description}</p>
      <dl className={styles.meta}>
        <dt>Priority</dt>
        <dd className={task.priority === 'High' ? styles.high : undefined}>{task.priority}</dd>
        <dt>Assignee</dt>
        <dd>{task.assignee}</dd>
        <dt>Created</dt>
        <dd>{formatDate(task.createdAt)}</dd>
      </dl>
      <div className={styles.actions}>
        <select
          aria-label={`Status for ${task.title}`}
          value={task.status}
          onChange={(e) => onStatusChange(task.id, e.target.value as TaskStatus)}
        >
          {TASK_STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <button type="button" className="btn" onClick={() => onEdit(task)}>
          Edit
        </button>
        <button type="button" className="btn btn-danger" onClick={() => onDelete(task.id)}>
          Delete
        </button>
      </div>
    </article>
  );
}
