import { PRIORITY_FILTER_OPTIONS, type PriorityFilterValue } from '../utils/priorityFilter';
import styles from './PriorityFilter.module.css';

interface PriorityFilterProps {
  value: PriorityFilterValue;
  onChange: (value: PriorityFilterValue) => void;
}

export function PriorityFilter({ value, onChange }: PriorityFilterProps) {
  return (
    <label className={styles.label}>
      Filter by priority
      <select value={value} onChange={(e) => onChange(e.target.value as PriorityFilterValue)}>
        {PRIORITY_FILTER_OPTIONS.map((option) => (
          <option key={option}>{option}</option>
        ))}
      </select>
    </label>
  );
}
