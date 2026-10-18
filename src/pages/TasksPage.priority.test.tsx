import { screen, within } from '@testing-library/react';
import { seedTasks } from '../data/seedTasks';
import { TaskService } from '../services/taskService';
import { renderApp } from '../test/renderApp';

const cardTitles = () => screen.queryAllByRole('article').map((a) => a.getAttribute('aria-label'));
const titlesWithPriority = (priority: string) =>
  seedTasks.filter((t) => t.priority === priority).map((t) => t.title);
const filter = () => screen.getByRole('combobox', { name: 'Filter by priority' });

describe('Priority filter', () => {
  it('renders with All selected and every option available', () => {
    renderApp('/tasks');
    expect(filter()).toHaveValue('All');
    expect(
      within(filter())
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['All', 'Low', 'Medium', 'High']);
  });

  it('shows all tasks for All', () => {
    renderApp('/tasks');
    expect(cardTitles()).toHaveLength(seedTasks.length);
  });

  it.each(['Low', 'Medium', 'High'])('shows only %s priority tasks', async (priority) => {
    const { user } = renderApp('/tasks');
    await user.selectOptions(filter(), priority);
    expect(cardTitles()).toEqual(titlesWithPriority(priority));
  });

  it('shows a message when no tasks have the selected priority', async () => {
    for (const t of seedTasks.filter((t) => t.priority === 'Low')) TaskService.remove(t.id);
    const { user } = renderApp('/tasks');
    await user.selectOptions(filter(), 'Low');
    expect(cardTitles()).toHaveLength(0);
    expect(screen.getByText('No tasks found for this priority.')).toBeInTheDocument();
  });

  it('restores all tasks when switching back to All', async () => {
    const { user } = renderApp('/tasks');
    await user.selectOptions(filter(), 'High');
    expect(cardTitles()).toHaveLength(titlesWithPriority('High').length);
    await user.selectOptions(filter(), 'All');
    expect(cardTitles()).toHaveLength(seedTasks.length);
  });

  it('does not modify stored tasks', async () => {
    const { user } = renderApp('/tasks');
    const before = localStorage.getItem('flowboard.tasks');
    await user.selectOptions(filter(), 'High');
    expect(localStorage.getItem('flowboard.tasks')).toBe(before);
  });
});
