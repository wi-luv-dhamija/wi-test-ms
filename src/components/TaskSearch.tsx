import styles from './TaskSearch.module.css';

interface TaskSearchProps {
  value: string;
  onChange: (value: string) => void;
}

export function TaskSearch({ value, onChange }: TaskSearchProps) {
  return (
    <input
      type="search"
      className={styles.input}
      placeholder="Search tasks..."
      aria-label="Search tasks"
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}
