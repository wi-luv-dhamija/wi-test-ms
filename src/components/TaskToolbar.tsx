import styles from './TaskToolbar.module.css';

export type TaskViewMode = 'grid' | 'list';

const viewModes: { mode: TaskViewMode; label: string }[] = [
  { mode: 'grid', label: 'Grid View' },
  { mode: 'list', label: 'List View' },
];

interface TaskToolbarProps {
  viewMode: TaskViewMode;
  onViewModeChange: (mode: TaskViewMode) => void;
  canAddTask: boolean;
  onAddTask: () => void;
}

export function TaskToolbar({
  viewMode,
  onViewModeChange,
  canAddTask,
  onAddTask,
}: TaskToolbarProps) {
  return (
    <div className={styles.toolbar}>
      <h1>Tasks</h1>
      <div className={styles.actions}>
        <div className={styles.viewToggle} role="group" aria-label="View mode">
          {viewModes.map(({ mode, label }) => (
            <button
              key={mode}
              type="button"
              aria-pressed={viewMode === mode}
              onClick={() => onViewModeChange(mode)}
            >
              {label}
            </button>
          ))}
        </div>
        {canAddTask && (
          <button type="button" className="btn btn-primary" onClick={onAddTask}>
            Add task
          </button>
        )}
      </div>
    </div>
  );
}
