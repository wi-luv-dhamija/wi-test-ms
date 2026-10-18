import { render, screen } from '@testing-library/react';
import { seedTasks } from '../data/seedTasks';
import { TaskService } from '../services/taskService';
import { renderApp } from '../test/renderApp';
import { getCompletionPercentage } from '../utils/taskStats';
import { TaskCompletionProgress } from './TaskCompletionProgress';

const expectProgress = (summary: string, percentage: number) => {
  expect(screen.getByText(summary)).toBeInTheDocument();
  expect(screen.getByText(`${percentage}%`)).toBeInTheDocument();
  expect(screen.getByRole('progressbar', { name: 'Task completion' })).toHaveAttribute(
    'value',
    String(percentage),
  );
};

describe('TaskCompletionProgress', () => {
  it.each([
    { completed: 6, total: 10, summary: '6 of 10 tasks completed', percentage: 60 },
    { completed: 0, total: 0, summary: '0 of 0 tasks completed', percentage: 0 },
    { completed: 5, total: 5, summary: '5 of 5 tasks completed', percentage: 100 },
    { completed: 0, total: 5, summary: '0 of 5 tasks completed', percentage: 0 },
  ])('shows $summary as $percentage%', ({ completed, total, summary, percentage }) => {
    render(<TaskCompletionProgress completed={completed} total={total} />);
    expectProgress(summary, percentage);
  });

  it('rounds the percentage', () => {
    expect(getCompletionPercentage(3, 8)).toBe(38);
    expect(getCompletionPercentage(1, 3)).toBe(33);
  });
});

describe('Dashboard completion progress', () => {
  it('renders on the dashboard from all stored tasks', () => {
    renderApp('/');
    expect(screen.getByRole('heading', { name: 'Task Completion' })).toBeInTheDocument();
    const completed = seedTasks.filter((t) => t.status === 'Completed').length;
    expectProgress(
      `${completed} of ${seedTasks.length} tasks completed`,
      getCompletionPercentage(completed, seedTasks.length),
    );
  });

  it('reflects status changes in stored tasks', () => {
    for (const t of seedTasks) TaskService.updateStatus(t.id, 'Completed');
    renderApp('/');
    expectProgress(`${seedTasks.length} of ${seedTasks.length} tasks completed`, 100);
  });
});
