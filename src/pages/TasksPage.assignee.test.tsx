import { screen, within } from '@testing-library/react';
import { seedTasks } from '../data/seedTasks';
import { TASKS_STORAGE_KEY } from '../services/taskStorage';
import type { Task } from '../types/task';
import { renderApp } from '../test/renderApp';

const stored = (): Task[] => JSON.parse(localStorage.getItem(TASKS_STORAGE_KEY)!);
const storedByTitle = (title: string) => stored().find((t) => t.title === title)!;

describe('Structured assignee', () => {
  it('displays the assignee name on task cards', () => {
    renderApp('/tasks');
    const card = screen.getByRole('article', { name: 'Audit accessibility' });
    expect(within(card).getByText('Sofia Garcia')).toBeInTheDocument();
    expect(screen.queryByText(/\[object Object\]/)).not.toBeInTheDocument();
  });

  it('stores new tasks with a structured assignee', async () => {
    const { user } = renderApp('/tasks');
    await user.click(screen.getByRole('button', { name: 'Add task' }));
    await user.type(screen.getByLabelText('Title'), 'New task');
    await user.type(screen.getByLabelText('Assignee'), 'Jordan Blake');
    await user.click(screen.getByRole('button', { name: 'Create task' }));

    expect(storedByTitle('New task').assignee).toEqual({
      id: 'user-jordan-blake',
      name: 'Jordan Blake',
    });
  });

  it('keeps the assignee id when editing other fields', async () => {
    const { user } = renderApp('/tasks');
    const original = seedTasks.find((t) => t.title === 'Audit accessibility')!.assignee;
    const card = screen.getByRole('article', { name: 'Audit accessibility' });
    await user.click(within(card).getByRole('button', { name: 'Edit' }));
    await user.type(screen.getByLabelText('Title'), ' v2');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(storedByTitle('Audit accessibility v2').assignee).toEqual(original);
  });

  it('stores a new structured assignee when the name is changed', async () => {
    const { user } = renderApp('/tasks');
    const card = screen.getByRole('article', { name: 'Audit accessibility' });
    await user.click(within(card).getByRole('button', { name: 'Edit' }));
    const assignee = screen.getByLabelText('Assignee');
    await user.clear(assignee);
    await user.type(assignee, 'Lee Wong');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(storedByTitle('Audit accessibility').assignee).toEqual({
      id: 'user-lee-wong',
      name: 'Lee Wong',
    });
    expect(
      within(screen.getByRole('article', { name: 'Audit accessibility' })).getByText('Lee Wong'),
    ).toBeInTheDocument();
  });

  it('displays tasks saved with the legacy string assignee', () => {
    localStorage.setItem(
      TASKS_STORAGE_KEY,
      JSON.stringify([{ ...seedTasks[0], assignee: 'Legacy Person' }]),
    );
    renderApp('/tasks');
    expect(screen.getByText('Legacy Person')).toBeInTheDocument();
  });
});
