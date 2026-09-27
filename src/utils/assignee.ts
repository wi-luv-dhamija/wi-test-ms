import type { Assignee } from '../types/task';

/** Builds an assignee with an id derived from the name, so the same name always gets the same id. */
export function createAssignee(name: string): Assignee {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return { id: `user-${slug || 'unknown'}`, name: name.trim() };
}
