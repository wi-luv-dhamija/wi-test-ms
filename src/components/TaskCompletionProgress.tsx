import { getCompletionPercentage } from '../utils/taskStats';
import styles from './TaskCompletionProgress.module.css';

interface TaskCompletionProgressProps {
  completed: number;
  total: number;
}

export function TaskCompletionProgress({ completed, total }: TaskCompletionProgressProps) {
  const percentage = getCompletionPercentage(completed, total);

  return (
    <section className={styles.card} aria-labelledby="completion-heading">
      <div className={styles.header}>
        <div>
          <h2 id="completion-heading">Task Completion</h2>
          <p className="muted">
            {completed} of {total} tasks completed
          </p>
        </div>
        <span className={styles.percentage}>{percentage}%</span>
      </div>
      <progress className={styles.bar} max={100} value={percentage} aria-label="Task completion" />
    </section>
  );
}
