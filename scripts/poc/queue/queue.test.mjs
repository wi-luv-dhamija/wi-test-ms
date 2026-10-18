import {
  addEntry,
  applyNewRevision,
  applyResult,
  bumpRevision,
  emptyState,
  findEntry,
  isDeployed,
  mergePlan,
  moveEntry,
  moveToEnd,
  nextCandidateId,
  parseCommand,
  parseState,
  positionOf,
  queueEntries,
  serializeState,
  signature,
  stateLabel,
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
  const state = emptyState('develop');
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
  it('parses /<verb> <stage> commands', () => {
    expect(parseCommand('/add develop')).toEqual({ stage: 'develop', name: 'add', args: [] });
    expect(parseCommand('  /MOVE QA #5 2\nplease')).toEqual({
      stage: 'qa',
      name: 'move',
      args: ['#5', '2'],
    });
    expect(parseCommand('/remove qa')).toMatchObject({ stage: 'qa', name: 'remove' });
    expect(parseCommand('/add')).toEqual({ stage: null, name: 'add', args: [] });
    expect(parseCommand('/hold #3')).toEqual({ stage: null, name: 'hold', args: ['#3'] });
    expect(parseCommand('please /add qa')).toBeNull();
    expect(parseCommand('/deploy qa')).toBeNull();
    expect(parseCommand('/queue add')).toBeNull();
  });

  it('labels each stage separately', () => {
    expect(stateLabel('develop', { state: 'DEPLOYED' })).toBe('develop:deployed');
    expect(stateLabel('qa', { state: 'STALE_PR' })).toBe('qa:stale');
    expect(stateLabel('qa', { state: 'REMOVED' })).toBeNull();
    const approved = { state: 'DEPLOYED', head_sha: 'a', approved: { sha: 'a' } };
    expect(stateLabel('qa', approved)).toBe('qa:approved');
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

  it('numbers candidates deterministically, per stage', () => {
    const state = emptyState('develop');
    expect([nextCandidateId(state), nextCandidateId(state)]).toEqual(['dev-rc-001', 'dev-rc-002']);
    expect(nextCandidateId(emptyState('qa'))).toBe('qa-rc-001');
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

  it('marks every PR deployed with the tag, with nothing more to do', () => {
    const state = validating(1, 2, 5);
    expect(applyResult(state, { status: 'DEPLOYED', tag: 'develop/rc-7' }).revalidate).toBe(false);
    expect(states(state)).toEqual({ 1: 'DEPLOYED', 2: 'DEPLOYED', 5: 'DEPLOYED' });
    expect(findEntry(state, 2)).toMatchObject({
      deployed_sha: pr(2).head_sha,
      deployed_tag: 'develop/rc-7',
    });
  });

  it('keeps PRs queued when only the deployment failed', () => {
    const state = validating(1, 2);
    expect(applyResult(state, { status: 'DEPLOY_FAILED' }).revalidate).toBe(false);
    expect(states(state)).toEqual({ 1: 'QUEUED', 2: 'QUEUED' });
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

  it('rebuilds the prefix when the failing PR was last, so that it gets deployed', () => {
    const state = validating(1, 2, 3);
    const result = { status: 'MERGE_CONFLICT', first_failing_pr: 3, passed_prs: [1, 2] };
    expect(applyResult(state, result).revalidate).toBe(true);
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

describe('promotion to qa', () => {
  const deployed = () => {
    const state = queueOf(1, 2);
    for (const n of [1, 2]) {
      transition(findEntry(state, n), 'DEPLOYED', {
        deployed_sha: pr(n).head_sha,
        deployed_tag: 'develop/rc-1',
      });
    }
    return state;
  };

  it('accepts only the revision develop deployed', () => {
    const state = deployed();
    expect(isDeployed(state, 1, pr(1).head_sha)).toBe(true);
    expect(isDeployed(state, 1, 'f'.repeat(40))).toBe(false);
    expect(isDeployed(state, 9, pr(9).head_sha)).toBe(false);
  });

  it('still accepts a deployed PR while develop redeploys', () => {
    const state = deployed();
    bumpRevision(state);
    expect(findEntry(state, 1).state).toBe('QUEUED');
    expect(isDeployed(state, 1, pr(1).head_sha)).toBe(true);
  });

  it('rejects a PR that left the develop queue', () => {
    const state = deployed();
    transition(findEntry(state, 1), 'HELD');
    expect(isDeployed(state, 1, pr(1).head_sha)).toBe(false);
    applyNewRevision(findEntry(state, 2), 'f'.repeat(40));
    expect(isDeployed(state, 2, 'f'.repeat(40))).toBe(false);
  });
});

describe('qa approval and merge', () => {
  const qaDeployed = (...numbers) => {
    const state = { ...queueOf(...numbers), stage: 'qa' };
    for (const n of numbers) {
      transition(findEntry(state, n), 'DEPLOYED', {
        deployed_sha: pr(n).head_sha,
        deployed_tag: 'qa/rc-9',
      });
    }
    state.current_candidate = { id: 'qa-rc-001', prs: numbers, status: 'DEPLOYED', tag: 'qa/rc-9' };
    return state;
  };
  const approve = (state, n) => {
    findEntry(state, n).approved = { by: 'qa', sha: pr(n).head_sha };
  };

  it('merges the approved PRs from the front of the queue, in order', () => {
    const state = qaDeployed(1, 2, 3);
    approve(state, 1);
    approve(state, 2);
    expect(mergePlan(state)).toEqual({ prs: [1, 2], tag: 'qa/rc-9', blocker: 3 });
  });

  it('stops at the first PR that is not approved', () => {
    const state = qaDeployed(1, 2, 3);
    approve(state, 2);
    approve(state, 3);
    expect(mergePlan(state)).toEqual({ prs: [], tag: 'qa/rc-9', blocker: 1 });
  });

  it('merges nothing while the queue is redeploying, but keeps approvals', () => {
    const state = qaDeployed(1);
    approve(state, 1);
    bumpRevision(state);
    state.current_candidate.status = 'VALIDATING';
    expect(mergePlan(state).prs).toEqual([]);
    expect(findEntry(state, 1).approved).not.toBeNull();
  });

  it('drops the approval on new commits or leaving the queue', () => {
    const state = qaDeployed(1, 2);
    approve(state, 1);
    approve(state, 2);
    applyNewRevision(findEntry(state, 1), 'f'.repeat(40));
    transition(findEntry(state, 2), 'HELD');
    expect(findEntry(state, 1).approved).toBeNull();
    expect(findEntry(state, 2).approved).toBeNull();
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
    expect(md).toContain('# 🚦 POC Develop Queue');
    expect(md).toContain('`/retry develop`');
    expect(md).not.toContain('/queue');
    expect(parseState(md)).toEqual(state);
  });

  it('renders a PR comment with the marker, position and queue', () => {
    const state = queueOf(1, 2, 5);
    const md = renderPrComment(state, findEntry(state, 5));
    expect(md.startsWith('<!-- POC_DEVELOP_QUEUE_STATUS -->')).toBe(true);
    expect(md).toContain('**Queue position:** 3 of 3');
    expect(md).toContain('#1 → #2 → **#5**');
    expect(md).toContain('`/hold develop`');
  });

  it('points a deployed develop PR at the qa queue and a deployed qa PR at approval', () => {
    const dev = queueOf(1);
    transition(findEntry(dev, 1), 'DEPLOYED', { deployed_tag: 'develop/rc-3' });
    expect(renderPrComment(dev, findEntry(dev, 1))).toContain('`/add qa`');
    const qa = { ...queueOf(1), stage: 'qa' };
    transition(findEntry(qa, 1), 'DEPLOYED', { deployed_tag: 'qa/rc-4' });
    const md = renderPrComment(qa, findEntry(qa, 1));
    expect(md.startsWith('<!-- POC_QA_QUEUE_STATUS -->')).toBe(true);
    expect(md).toContain('`/approve qa`');
  });
});
