import { screen, within } from '@testing-library/react';
import { seedTasks } from '../data/seedTasks';
import { renderApp } from '../test/renderApp';

const gridButton = () => screen.getByRole('button', { name: 'Grid View' });
const listButton = () => screen.getByRole('button', { name: 'List View' });
const collection = () => screen.getByTestId('task-collection');

describe('Task toolbar and view toggle', () => {
  it('renders the toolbar with heading, view toggle and add button', () => {
    renderApp('/tasks');
    expect(screen.getByRole('heading', { level: 1, name: 'Tasks' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'View mode' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add task' })).toBeInTheDocument();
  });

  it('selects Grid View by default', () => {
    renderApp('/tasks');
    expect(gridButton()).toHaveAttribute('aria-pressed', 'true');
    expect(listButton()).toHaveAttribute('aria-pressed', 'false');
    expect(collection()).toHaveAttribute('data-view', 'grid');
  });

  it('switches to List View and back to Grid View', async () => {
    const { user } = renderApp('/tasks');
    await user.click(listButton());
    expect(listButton()).toHaveAttribute('aria-pressed', 'true');
    expect(gridButton()).toHaveAttribute('aria-pressed', 'false');
    expect(collection()).toHaveAttribute('data-view', 'list');

    await user.click(gridButton());
    expect(gridButton()).toHaveAttribute('aria-pressed', 'true');
    expect(collection()).toHaveAttribute('data-view', 'grid');
  });

  it('shows every task in both views, with title, status, priority and assignee in list rows', async () => {
    const { user } = renderApp('/tasks');
    expect(screen.getAllByRole('article')).toHaveLength(seedTasks.length);

    await user.click(listButton());
    expect(screen.getAllByRole('article')).toHaveLength(seedTasks.length);
    const task = seedTasks[0];
    const row = screen.getByRole('article', { name: task.title });
    expect(within(row).getByRole('heading', { name: task.title })).toBeInTheDocument();
    expect(within(row).getByText(task.status, { selector: 'span' })).toBeInTheDocument();
    expect(within(row).getByText(task.priority)).toBeInTheDocument();
    expect(within(row).getByText(task.assignee)).toBeInTheDocument();
    expect(within(row).queryByText(task.description)).not.toBeInTheDocument();
  });

  it('keeps task actions working in List View', async () => {
    const { user } = renderApp('/tasks');
    await user.click(listButton());

    const row = screen.getByRole('article', { name: 'Audit accessibility' });
    await user.selectOptions(
      within(row).getByLabelText('Status for Audit accessibility'),
      'Completed',
    );
    expect(within(row).getByText('Completed', { selector: 'span' })).toBeInTheDocument();

    await user.click(within(row).getByRole('button', { name: 'Delete' }));
    expect(screen.queryByRole('article', { name: 'Audit accessibility' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Add task' }));
    await user.type(screen.getByLabelText('Title'), 'Row task');
    await user.type(screen.getByLabelText('Assignee'), 'Kim');
    await user.click(screen.getByRole('button', { name: 'Create task' }));
    expect(screen.getByRole('article', { name: 'Row task' })).toBeInTheDocument();
    expect(collection()).toHaveAttribute('data-view', 'list');
  });
});
