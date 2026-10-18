import { screen } from '@testing-library/react';
import { seedTasks } from '../data/seedTasks';
import { renderApp } from '../test/renderApp';

const cardTitles = () => screen.queryAllByRole('article').map((a) => a.getAttribute('aria-label'));

describe('Task search', () => {
  it('renders the search input', () => {
    renderApp('/tasks');
    expect(screen.getByPlaceholderText('Search tasks...')).toBeInTheDocument();
  });

  it('shows all tasks when the search is empty', () => {
    renderApp('/tasks');
    expect(screen.getByRole('searchbox', { name: 'Search tasks' })).toHaveValue('');
    expect(screen.getAllByRole('article')).toHaveLength(seedTasks.length);
  });

  it('filters by title', async () => {
    const { user } = renderApp('/tasks');
    await user.type(screen.getByRole('searchbox'), 'onboarding');
    expect(cardTitles()).toEqual(['Write onboarding guide']);
  });

  it('filters by description', async () => {
    const { user } = renderApp('/tasks');
    await user.type(screen.getByRole('searchbox'), 'wireframes');
    expect(cardTitles()).toEqual(['Design dashboard layout']);
  });

  it('filters by assignee', async () => {
    const { user } = renderApp('/tasks');
    await user.type(screen.getByRole('searchbox'), 'Priya');
    expect(cardTitles()).toEqual(['Implement task filters', 'Review merge-queue policy']);
  });

  it('is case-insensitive', async () => {
    const { user } = renderApp('/tasks');
    const search = screen.getByRole('searchbox');
    await user.type(search, 'PRIYA');
    expect(cardTitles()).toHaveLength(2);
    await user.clear(search);
    await user.type(search, 'priya');
    expect(cardTitles()).toHaveLength(2);
  });

  it('shows a message when nothing matches', async () => {
    const { user } = renderApp('/tasks');
    await user.type(screen.getByRole('searchbox'), 'zzz-no-match');
    expect(screen.queryAllByRole('article')).toHaveLength(0);
    expect(screen.getByText('No tasks match your search.')).toBeInTheDocument();
  });

  it('restores the full list when the search is cleared', async () => {
    const { user } = renderApp('/tasks');
    const search = screen.getByRole('searchbox');
    await user.type(search, 'onboarding');
    expect(screen.getAllByRole('article')).toHaveLength(1);
    await user.clear(search);
    expect(screen.getAllByRole('article')).toHaveLength(seedTasks.length);
    expect(screen.queryByText('No tasks match your search.')).not.toBeInTheDocument();
  });

  it('does not modify stored tasks', async () => {
    const { user } = renderApp('/tasks');
    const before = localStorage.getItem('flowboard.tasks');
    await user.type(screen.getByRole('searchbox'), 'onboarding');
    expect(localStorage.getItem('flowboard.tasks')).toBe(before);
  });
});
