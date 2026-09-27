import { screen, within } from '@testing-library/react';
import { seedTasks } from './data/seedTasks';
import { renderApp } from './test/renderApp';

describe('Dashboard', () => {
  it('renders summary stats and recent tasks', () => {
    renderApp('/');
    expect(screen.getByRole('heading', { name: 'Dashboard' })).toBeInTheDocument();
    expect(within(screen.getByRole('group', { name: 'Total tasks' })).getByText('8')).toBeVisible();
    expect(within(screen.getByRole('group', { name: 'Completed' })).getByText('2')).toBeVisible();
    expect(within(screen.getByRole('group', { name: 'In progress' })).getByText('3')).toBeVisible();
    expect(within(screen.getByRole('group', { name: 'Pending' })).getByText('3')).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Recent tasks' })).toBeInTheDocument();
    expect(screen.getByText('Review merge-queue policy')).toBeInTheDocument();
  });
});

describe('Tasks page', () => {
  it('loads the seed tasks', () => {
    renderApp('/tasks');
    expect(screen.getAllByRole('article')).toHaveLength(seedTasks.length);
    for (const task of seedTasks) {
      expect(screen.getByRole('article', { name: task.title })).toBeInTheDocument();
    }
  });

  it('creates a task', async () => {
    const { user } = renderApp('/tasks');
    await user.click(screen.getByRole('button', { name: 'Add task' }));
    await user.type(screen.getByLabelText('Title'), 'Ship release candidate');
    await user.type(screen.getByLabelText('Description'), 'Cut RC from main');
    await user.selectOptions(screen.getByLabelText('Priority'), 'High');
    await user.type(screen.getByLabelText('Assignee'), 'Jordan');
    await user.click(screen.getByRole('button', { name: 'Create task' }));

    const card = screen.getByRole('article', { name: 'Ship release candidate' });
    expect(within(card).getByText('Jordan')).toBeInTheDocument();
    expect(within(card).getByText('High')).toBeInTheDocument();
    expect(screen.getAllByRole('article')).toHaveLength(seedTasks.length + 1);
  });

  it('edits a task', async () => {
    const { user } = renderApp('/tasks');
    const card = screen.getByRole('article', { name: 'Audit accessibility' });
    await user.click(within(card).getByRole('button', { name: 'Edit' }));
    const title = screen.getByLabelText('Title');
    await user.clear(title);
    await user.type(title, 'Audit a11y');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(screen.getByRole('article', { name: 'Audit a11y' })).toBeInTheDocument();
    expect(screen.queryByRole('article', { name: 'Audit accessibility' })).not.toBeInTheDocument();
  });

  it('deletes a task', async () => {
    const { user } = renderApp('/tasks');
    const card = screen.getByRole('article', { name: 'Prepare release notes' });
    await user.click(within(card).getByRole('button', { name: 'Delete' }));

    expect(
      screen.queryByRole('article', { name: 'Prepare release notes' }),
    ).not.toBeInTheDocument();
    expect(screen.getAllByRole('article')).toHaveLength(seedTasks.length - 1);
  });

  it('changes task status and persists it', async () => {
    const { user } = renderApp('/tasks');
    const card = screen.getByRole('article', { name: 'Audit accessibility' });
    await user.selectOptions(
      within(card).getByLabelText('Status for Audit accessibility'),
      'Completed',
    );

    expect(within(card).getByText('Completed', { selector: 'span' })).toBeInTheDocument();
    const stored = JSON.parse(localStorage.getItem('flowboard.tasks')!);
    expect(stored.find((t: { title: string }) => t.title === 'Audit accessibility').status).toBe(
      'Completed',
    );
  });
});

describe('Navigation', () => {
  it('moves between pages via the top nav', async () => {
    const { user } = renderApp('/');
    const nav = screen.getByRole('navigation', { name: 'Main' });

    await user.click(within(nav).getByRole('link', { name: 'Tasks' }));
    expect(screen.getByRole('heading', { level: 1, name: 'Tasks' })).toBeInTheDocument();

    await user.click(within(nav).getByRole('link', { name: 'About' }));
    expect(screen.getByRole('heading', { name: 'About FlowBoard' })).toBeInTheDocument();

    await user.click(within(nav).getByRole('link', { name: 'Dashboard' }));
    expect(screen.getByRole('heading', { name: 'Dashboard' })).toBeInTheDocument();
  });
});
