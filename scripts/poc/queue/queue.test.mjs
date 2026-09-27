import {
  addEntry,
  applyNewRevision,
  applyResult,
  bumpRevision,
  emptyState,
  findEntry,
  moveEntry,
  moveToEnd,
  nextCandidateId,
  parseCommand,
  parseState,
  positionOf,
  queueEntries,
  serializeState,
  signature,
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
const order = (state) => queueEntries(state).map((e) => e.number);
const states = (state) => Object.fromEntries(state.entries.map((e) => [e.number, e.state]));

describe('queue state persistence', () => {
  it('round-trips through the issue body, escaping text that could close the comment', () => {
    const state = queueOf(1);
    findEntry(state, 1).title = 'evil --> <!-- title';
    const body = `# dashboard\n${serializeState(state)}\n`;
    expect(body.split('-->').length).toBe(2); // only the real terminator
    expect(parseState(body)).toEqual(state);
  });

  it('fills fields added later when reading an older state', () => {
    const { revision, ...old } = queueOf(1);
    expect(revision).toBe(0);
    expect(parseState(serializeState(old)).revision).toBe(0);
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
  it('hold removes a PR from the queue; resume puts it at the end', () => {
    const state = queueOf(1, 2, 5);
    transition(findEntry(state, 2), 'HELD');
    expect(order(state)).toEqual([1, 5]);
    const e = findEntry(state, 2);
    transition(e, 'QUEUED');
    moveToEnd(state, e);
    expect(order(state)).toEqual([1, 5, 2]);
    expect(positionOf(state, 2)).toBe(3);
  });

  it('moves a PR to a queue position, skipping entries outside the queue', () => {
    const state = queueOf(1, 2, 3, 5);
    transition(findEntry(state, 2), 'HELD');
    moveEntry(state, findEntry(state, 5), 1);
    expect(order(state)).toEqual([5, 1, 3]);
    moveEntry(state, findEntry(state, 5), 99);
    expect(order(state)).toEqual([1, 3, 5]);
  });

  it('keeps an ejected PR in its slot so retry returns it to the same place', () => {
    const state = queueOf(1, 2, 3);
    transition(findEntry(state, 2), 'TEST_FAILED');
    expect(order(state)).toEqual([1, 3]);
    transition(findEntry(state, 2), 'QUEUED'); // /queue retry
    expect(order(state)).toEqual([1, 2, 3]);
  });

  it('numbers candidates deterministically', () => {
    const state = emptyState();
    expect([nextCandidateId(state), nextCandidateId(state)]).toEqual(['rc-001', 'rc-002']);
  });
});

describe('revisions', () => {
  it('changes the signature when the queued PRs or their SHAs change', () => {
    const state = queueOf(1, 2);
    const before = signature(state);
    transition(findEntry(state, 2), 'HELD');
    expect(signature(state)).not.toBe(before);
    expect(signature(queueOf(1, 2))).toBe(before);
  });

  it('bumps the revision and sends validated PRs back to queued', () => {
    const state = queueOf(1, 2);
    transition(findEntry(state, 1), 'VALIDATED');
    expect(bumpRevision(state)).toEqual([1]);
    expect(state.revision).toBe(1);
    expect(states(state)).toEqual({ 1: 'QUEUED', 2: 'QUEUED' });
  });

  it('pops a queued PR out of the queue on new commits', () => {
    const state = queueOf(1, 2);
    const e = findEntry(state, 2);
    transition(e, 'VALIDATED');
    expect(applyNewRevision(e, 'f'.repeat(40))).toBe(true);
    expect(e.state).toBe('STALE_PR');
    expect(e.new_revision).toMatchObject({ from: pr(2).head_sha, to: 'f'.repeat(40) });
    expect(order(state)).toEqual([1]);
    expect(applyNewRevision(e, 'f'.repeat(40))).toBe(false);
  });

  it('only records the new SHA for a held PR', () => {
    const state = queueOf(1);
    const e = findEntry(state, 1);
    transition(e, 'HELD');
    applyNewRevision(e, 'e'.repeat(40));
    expect(e.state).toBe('HELD');
    expect(e.head_sha).toBe('e'.repeat(40));
  });
});

describe('candidate results', () => {
  const validating = (...numbers) => {
    const state = queueOf(...numbers);
    for (const n of numbers) transition(findEntry(state, n), 'VALIDATING');
    state.current_candidate = {
      id: 'rc-001',
      prs: numbers,
      shas: Object.fromEntries(numbers.map((n) => [n, pr(n).head_sha])),
      status: 'VALIDATING',
    };
    return state;
  };

  it('marks every PR validated on success, with nothing more to do', () => {
    const state = validating(1, 2, 5);
    expect(applyResult(state, { status: 'VALIDATED' }).revalidate).toBe(false);
    expect(states(state)).toEqual({ 1: 'VALIDATED', 2: 'VALIDATED', 5: 'VALIDATED' });
  });

  it('ejects the first failing PR and revalidates the PRs after it', () => {
    const state = validating(1, 2, 3, 5);
    const detail = { type: 'TEST_FAILED', related_prs: [1, 3] };
    const { revalidate } = applyResult(state, {
      status: 'TEST_FAILED',
      first_failing_pr: 3,
      passed_prs: [1, 2],
      detail,
    });
    expect(states(state)).toEqual({
      1: 'VALIDATED',
      2: 'VALIDATED',
      3: 'TEST_FAILED',
      5: 'QUEUED',
    });
    expect(revalidate).toBe(true);
    expect(order(state)).toEqual([1, 2, 5]);
    expect(findEntry(state, 3)).toMatchObject({
      result_detail: detail,
      failure: { candidate: 'rc-001', passed_prs: [1, 2], first_failing_pr: 3 },
    });
  });

  it('does not rebuild when the failing PR was last (the prefix is already validated)', () => {
    const state = validating(1, 2, 3);
    const result = { status: 'MERGE_CONFLICT', first_failing_pr: 3, passed_prs: [1, 2] };
    expect(applyResult(state, result).revalidate).toBe(false);
    expect(order(state)).toEqual([1, 2]);
  });

  it('maps lint/build failures to BLOCKED', () => {
    const state = validating(1, 2);
    applyResult(state, { status: 'LINT_FAILED', first_failing_pr: 2, passed_prs: [1] });
    expect(findEntry(state, 2).state).toBe('BLOCKED');
  });

  it('pops the changed PR on STALE_PR and revalidates the rest', () => {
    const state = validating(1, 2);
    const { revalidate } = applyResult(state, {
      status: 'STALE_PR',
      stale_prs: { 2: 'e'.repeat(40) },
    });
    expect(states(state)).toEqual({ 1: 'QUEUED', 2: 'STALE_PR' });
    expect(findEntry(state, 2)).toMatchObject({ head_sha: 'e'.repeat(40) });
    expect(revalidate).toBe(true);
  });

  it('does not re-add a PR held or removed while the candidate ran', () => {
    const state = validating(1, 2);
    transition(findEntry(state, 2), 'REMOVED');
    applyResult(state, { status: 'VALIDATED' });
    expect(states(state)).toMatchObject({ 1: 'VALIDATED', 2: 'REMOVED' });
    expect(findEntry(state, 2).last_result).toBe('PASS');
  });
});

describe('rendering', () => {
  it('lists ejected PRs with their diagnosis and re-entry commands', () => {
    const state = queueOf(1, 2, 3, 5);
    transition(findEntry(state, 3), 'TEST_FAILED', {
      result_detail: {
        type: 'TEST_FAILED',
        related_prs: [1, 3],
        failed_tests: [{ file: 'a.test.tsx', tests: ['t'] }],
      },
    });
    const md = renderDashboard(state);
    expect(md).toContain('## ❌ Needs attention');
    expect(md).toContain('| #3 | Tests fail when combined with #1 |');
    expect(md).toContain('#1 ↔ #3');
    expect(md).not.toContain('/queue build');
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
