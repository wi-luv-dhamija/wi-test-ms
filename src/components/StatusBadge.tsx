import type { TaskStatus } from '../types/task';
import styles from './StatusBadge.module.css';

const statusClass: Record<TaskStatus, string> = {
  Pending: styles.pending,
  'In Progress': styles.inProgress,
  Completed: styles.completed,
};

export function StatusBadge({ status }: { status: TaskStatus }) {
  return <span className={`${styles.badge} ${statusClass[status]}`}>{status}</span>;
}
