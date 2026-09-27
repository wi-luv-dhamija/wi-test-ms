import {
  activeEntries,
  addEntry,
  applyNewRevision,
  applyResult,
  composition,
  emptyState,
  findEntry,
  moveEntry,
  moveToEnd,
  nextCandidateId,
  parseCommand,
  parseState,
  positionOf,
  serializeState,
  transition,
} from './queue.mjs';
import { renderDashboard, renderPrComment } from './render.mjs';

const pr = (number, extra = {}) => ({
  number,
  title: `PR ${number}`,
  author: `dev${number}`,
  branch: `feature/${number}`,
  head_sha: `${number}`.repeat(40).slice(0, 40),
  ...extra,
});
const queueOf = (...numbers) => {
  const state = emptyState();
  for (const n of numbers) addEntry(state, pr(n), 'alice', 'QUEUED');
  return state;
};
const order = (state) => activeEntries(state).map((e) => e.number);

describe('queue state persistence', () => {
  it('round-trips through the issue body, escaping text that could close the comment', () => {
    const state = queueOf(1);
    findEntry(state, 1).title = 'evil --> <!-- title';
    const body = `# dashboard\n${serializeState(state)}\n`;
    expect(body.split('-->').length).toBe(2); // only the real terminator
    expect(parseState(body)).toEqual(state);
  });

  it('returns null when the body has no state block', () => {
    expect(parseState('# just text')).toBeNull();
  });
});

describe('commands', () => {
  it('parses only comments starting with /queue', () => {
    expect(parseCommand('/queue add')).toEqual({ name: 'add', args: [] });
    expect(parseCommand('  /Queue MOVE #5 2\nplease')).toEqual({ name: 'move', args: ['#5', '2'] });
    expect(parseCommand('please /queue add')).toBeNull();
    expect(parseCommand('/queued')).toBeNull();
  });
});

describe('queue ordering', () => {
  it('hold excludes a PR from the active queue; resume puts it at the end', () => {
    const state = queueOf(1, 2, 5);
    transition(findEntry(state, 2), 'HELD');
    expect(order(state)).toEqual([1, 5]);
    expect(composition(state).prs.map((e) => e.number)).toEqual([1, 5]);
    const e = findEntry(state, 2);
    transition(e, 'QUEUED');
    moveToEnd(state, e);
    expect(order(state)).toEqual([1, 5, 2]);
    expect(positionOf(state, 2)).toBe(3);
  });

  it('moves a PR to an active position, skipping held entries', () => {
    const state = queueOf(1, 2, 3, 5);
    transition(findEntry(state, 2), 'HELD');
    moveEntry(state, findEntry(state, 5), 1);
    expect(order(state)).toEqual([5, 1, 3]);
    moveEntry(state, findEntry(state, 5), 99);
    expect(order(state)).toEqual([1, 3, 5]);
  });

  it('numbers candidates deterministically', () => {
    const state = emptyState();
    expect([nextCandidateId(state), nextCandidateId(state)]).toEqual(['rc-001', 'rc-002']);
  });

  it('flags a new revision and requires revalidation of a validated PR', () => {
    const state = queueOf(1);
    const e = findEntry(state, 1);
    transition(e, 'VALIDATED');
    expect(applyNewRevision(e, 'f'.repeat(40))).toBe(true);
    expect(e.state).toBe('QUEUED');
    expect(e.new_revision.to).toBe('f'.repeat(40));
    expect(applyNewRevision(e, 'f'.repeat(40))).toBe(false);
  });
});

describe('candidate results', () => {
  const building = (...numbers) => {
    const state = queueOf(...numbers, 9);
    for (const n of numbers) transition(findEntry(state, n), 'VALIDATING');
    state.current_candidate = {
      id: 'rc-001',
      prs: numbers,
      shas: Object.fromEntries(numbers.map((n) => [n, pr(n).head_sha])),
      status: 'VALIDATING',
    };
    return state;
  };
  const states = (state) => Object.fromEntries(state.entries.map((e) => [e.number, e.state]));

  it('marks every PR validated on success', () => {
    const state = building(1, 2, 5);
    applyResult(state, { status: 'VALIDATED', candidate_sha: 'abc' });
    expect(states(state)).toEqual({ 1: 'VALIDATED', 2: 'VALIDATED', 5: 'VALIDATED', 9: 'QUEUED' });
  });

  it('keeps the validated prefix, blocks the first failing addition and requeues the rest', () => {
    const state = building(1, 2, 3, 5);
    const detail = { type: 'TEST_FAILED', related_prs: [1, 3] };
    applyResult(state, { status: 'TEST_FAILED', first_failing_pr: 3, passed_prs: [1, 2], detail });
    expect(states(state)).toEqual({
      1: 'VALIDATED',
      2: 'VALIDATED',
      3: 'TEST_FAILED',
      5: 'QUEUED',
      9: 'QUEUED',
    });
    expect(findEntry(state, 3).result_detail).toBe(detail);
    expect(composition(state).blockers.map((e) => e.number)).toEqual([3]);
    // Suggested next candidate without #3, never applied automatically.
    expect(composition(state).prs.map((e) => e.number)).toEqual([1, 2, 5, 9]);
  });

  it('maps lint/build failures to BLOCKED', () => {
    const state = building(1, 2);
    applyResult(state, { status: 'LINT_FAILED', first_failing_pr: 2, passed_prs: [1] });
    expect(findEntry(state, 2).state).toBe('BLOCKED');
  });

  it('marks only the changed PR stale', () => {
    const state = building(1, 2);
    applyResult(state, { status: 'STALE_PR', stale_prs: { 2: 'e'.repeat(40) } });
    expect(states(state)).toMatchObject({ 1: 'QUEUED', 2: 'STALE_PR' });
    expect(findEntry(state, 2).new_revision).toMatchObject({
      from: pr(2).head_sha,
      to: 'e'.repeat(40),
    });
  });

  it('does not re-add a PR held or removed while the candidate ran', () => {
    const state = building(1, 2);
    transition(findEntry(state, 2), 'REMOVED');
    applyResult(state, { status: 'VALIDATED' });
    expect(states(state)).toMatchObject({ 1: 'VALIDATED', 2: 'REMOVED' });
    expect(findEntry(state, 2).last_result).toBe('PASS');
  });
});

describe('rendering', () => {
  it('shows blockers and the suggested candidate on the dashboard', () => {
    const state = queueOf(1, 2, 3, 5);
    const e = findEntry(state, 3);
    transition(e, 'TEST_FAILED', {
      result_detail: {
        type: 'TEST_FAILED',
        related_prs: [1, 3],
        failed_tests: [{ file: 'a.test.tsx', tests: ['t'] }],
      },
    });
    const md = renderDashboard(state);
    expect(md).toContain('## Current blocker');
    expect(md).toContain('#1 ↔ #3');
    expect(md).toContain('Suggested next candidate if #3 is held: **#1,#2,#5**');
    expect(parseState(md)).toEqual(state);
  });

  it('renders a PR comment with the marker, position and queue', () => {
    const state = queueOf(1, 2, 5);
    const md = renderPrComment(state, findEntry(state, 5));
    expect(md.startsWith('<!-- POC_QUEUE_STATUS -->')).toBe(true);
    expect(md).toContain('**Queue position:** 3 of 3');
    expect(md).toContain('#1 → #2 → **#5**');
  });
});
