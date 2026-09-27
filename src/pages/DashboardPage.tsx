import { Link } from 'react-router';
import { StatCard } from '../components/StatCard';
import { StatusBadge } from '../components/StatusBadge';
import { useTasks } from '../hooks/useTasks';
import { formatDate } from '../utils/date';
import { getRecentTasks, getTaskStats } from '../utils/taskStats';
import styles from './DashboardPage.module.css';

export function DashboardPage() {
  const { tasks } = useTasks();
  const stats = getTaskStats(tasks);
  const recent = getRecentTasks(tasks);

  return (
    <>
      <div className="page-header">
        <h1>Dashboard</h1>
      </div>
      <div className={styles.stats}>
        <StatCard label="Total tasks" value={stats.total} />
        <StatCard label="Completed" value={stats.completed} />
        <StatCard label="In progress" value={stats.inProgress} />
        <StatCard label="Pending" value={stats.pending} />
      </div>
      <section className={styles.section} aria-labelledby="recent-heading">
        <div className={styles.sectionHeader}>
          <h2 id="recent-heading">Recent tasks</h2>
          <Link to="/tasks">View all</Link>
        </div>
        {recent.length === 0 ? (
          <p className={`${styles.item} muted`}>No tasks yet.</p>
        ) : (
          <ul className={styles.list}>
            {recent.map((task) => (
              <li key={task.id} className={styles.item}>
                <div>
                  <div className={styles.itemTitle}>{task.title}</div>
                  <div className={`${styles.itemMeta} muted`}>
                    {task.assignee} · {formatDate(task.createdAt)}
                  </div>
                </div>
                <StatusBadge status={task.status} />
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
