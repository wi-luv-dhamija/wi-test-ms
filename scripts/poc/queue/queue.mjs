// Pure release-queue logic: the state model, command parsing and state transitions.
// No GitHub API calls here, so everything in this file is unit-testable.

/** Entries in the active queue, in order. Their position is their index among active entries. */
export const ACTIVE = new Set([
  'QUEUED',
  'VALIDATING',
  'VALIDATED',
  'TEST_FAILED',
  'MERGE_CONFLICT',
  'STALE_PR',
  'STALE_MAIN',
  'BLOCKED',
]);
/** Active states a new candidate may include. */
export const BUILDABLE = new Set(['QUEUED', 'VALIDATED', 'STALE_MAIN']);
/** Active states that need developer action before the next build. */
export const BLOCKING = new Set(['TEST_FAILED', 'MERGE_CONFLICT', 'STALE_PR', 'BLOCKED']);
/** Kept on the queue page but excluded from candidates. */
export const PARKED = new Set(['HELD', 'READY']);
/** No longer part of the queue (history only). */
export const INACTIVE = new Set(['REMOVED', 'MERGED']);

export const STATE_LABELS = {
  READY: 'queue:ready',
  QUEUED: 'queue:queued',
  VALIDATING: 'queue:validating',
  VALIDATED: 'queue:validated',
  HELD: 'queue:held',
  TEST_FAILED: 'queue:test-failed',
  MERGE_CONFLICT: 'queue:merge-conflict',
  STALE_PR: 'queue:stale',
  STALE_MAIN: 'queue:stale',
  BLOCKED: 'queue:blocked',
};
export const LABEL_COLORS = {
  'queue:ready': ['c5def5', 'Waiting for the queue to unfreeze'],
  'queue:queued': ['fbca04', 'In the active release queue'],
  'queue:validating': ['1d76db', 'Part of the candidate being validated'],
  'queue:validated': ['0e8a16', 'Validated in the latest candidate'],
  'queue:held': ['bfd4f2', 'Held: excluded from candidates'],
  'queue:test-failed': ['d73a4a', 'First failing addition: tests failed'],
  'queue:merge-conflict': ['b60205', 'First failing addition: merge conflict'],
  'queue:stale': ['e99695', 'Candidate went stale; rebuild or retry'],
  'queue:blocked': ['5319e7', 'Blocked: needs developer action'],
  'release-queue': ['0052cc', 'POC release queue dashboard'],
};

export const MUTATING = new Set([
  'add',
  'remove',
  'hold',
  'resume',
  'retry',
  'move',
  'build',
  'freeze',
  'unfreeze',
]);
export const QUEUE_ISSUE_ONLY = new Set(['build', 'freeze', 'unfreeze']);
export const COMMANDS = [
  'add',
  'remove',
  'hold',
  'resume',
  'retry',
  'status',
  'move',
  'build',
  'freeze',
  'unfreeze',
];

export const CANDIDATE_ID = /^[A-Za-z0-9._-]{1,64}$/;
const HISTORY_LIMIT = 15;
const INACTIVE_LIMIT = 20;

export function emptyState() {
  return {
    version: 1,
    frozen: false,
    frozen_by: null,
    frozen_at: null,
    candidate_counter: 0,
    current_candidate: null,
    entries: [],
    history: [],
  };
}

// ---- Persistence inside the queue issue body ----
export const STATE_START = '<!-- POC_QUEUE_STATE_START';
export const STATE_END = 'POC_QUEUE_STATE_END -->';

/** Returns the state stored in an issue body, or null if the body has no state block. */
export function parseState(body) {
  const start = body?.indexOf(STATE_START) ?? -1;
  const end = body?.indexOf(STATE_END) ?? -1;
  if (start < 0 || end < start) return null;
  return JSON.parse(body.slice(start + STATE_START.length, end));
}

/** Escapes '>' so user-controlled text (PR titles) can never close the HTML comment. */
export function serializeState(state) {
  return `${STATE_START}\n${JSON.stringify(state).replaceAll('>', '\\u003e')}\n${STATE_END}`;
}

// ---- Commands ----
/** Parses the first line of a comment. Returns null unless it starts with /queue. */
export function parseCommand(body) {
  const line = (body ?? '').trim().split(/\r?\n/)[0].trim();
  if (!/^\/queue(\s|$)/i.test(line)) return null;
  const [, name = 'help', ...args] = line.split(/\s+/);
  return { name: name.toLowerCase(), args };
}

/** Parses "#5" or "5" into a PR number. */
export const parsePrRef = (arg) =>
  /^#?\d+$/.test(arg ?? '') ? Number(arg.replace('#', '')) : null;

// ---- Queries ----
export const findEntry = (state, number) => state.entries.find((e) => e.number === number);
export const activeEntries = (state) => state.entries.filter((e) => ACTIVE.has(e.state));
export const positionOf = (state, number) => {
  const i = activeEntries(state).findIndex((e) => e.number === number);
  return i < 0 ? null : i + 1;
};
export const queueLine = (entries) => entries.map((e) => `#${e.number}`).join(' → ') || '(empty)';

/** What `/queue build` would do right now. */
export function composition(state) {
  const active = activeEntries(state);
  return {
    prs: active.filter((e) => BUILDABLE.has(e.state)),
    blockers: active.filter((e) => BLOCKING.has(e.state)),
    validating: active.filter((e) => e.state === 'VALIDATING'),
  };
}

// ---- Mutations (all return the previous state of the entry, where relevant) ----
export function transition(entry, next, patch = {}) {
  const prev = entry.state;
  Object.assign(entry, patch, {
    state: next,
    updated_at: patch.updated_at ?? new Date().toISOString(),
  });
  return prev;
}

export function addEntry(state, pr, by, initialState) {
  const existing = findEntry(state, pr.number);
  if (existing) state.entries.splice(state.entries.indexOf(existing), 1);
  const entry = {
    number: pr.number,
    title: pr.title,
    author: pr.author,
    branch: pr.branch,
    head_sha: pr.head_sha,
    state: initialState,
    added_at: new Date().toISOString(),
    added_by: by,
    last_candidate: null,
    last_result: null,
    result_detail: null,
    new_revision: null,
    state_reason: null,
    comment_id: existing?.comment_id ?? null,
    comment_hash: null,
    updated_at: new Date().toISOString(),
  };
  state.entries.push(entry);
  return entry;
}

/** Moves an entry to the end of the queue (e.g. `/queue resume`). */
export function moveToEnd(state, entry) {
  state.entries.splice(state.entries.indexOf(entry), 1);
  state.entries.push(entry);
}

/** Moves an active entry so it becomes active position `pos` (1-based, clamped). */
export function moveEntry(state, entry, pos) {
  const others = state.entries.filter((e) => e !== entry);
  const activeOthers = others.filter((e) => ACTIVE.has(e.state));
  const target = Math.max(1, pos);
  const index =
    target <= activeOthers.length
      ? others.indexOf(activeOthers[target - 1])
      : activeOthers.length
        ? others.indexOf(activeOthers.at(-1)) + 1
        : others.length;
  others.splice(index, 0, entry);
  state.entries = others;
}

export function recordHistory(state, item) {
  state.history.unshift({ at: new Date().toISOString(), ...item });
  state.history = state.history.slice(0, HISTORY_LIMIT);
}

/** Drops the oldest removed/merged entries so the issue body stays small. */
export function pruneInactive(state) {
  const inactive = state.entries.filter((e) => INACTIVE.has(e.state));
  const drop = new Set(
    inactive.sort((a, b) => a.updated_at.localeCompare(b.updated_at)).slice(0, -INACTIVE_LIMIT),
  );
  state.entries = state.entries.filter((e) => !drop.has(e));
}

/** Records a new head SHA; a VALIDATED PR must be validated again. Returns true if it changed. */
export function applyNewRevision(entry, sha) {
  if (!sha || sha === entry.head_sha) return false;
  entry.new_revision = { from: entry.head_sha, to: sha, at: new Date().toISOString() };
  entry.head_sha = sha;
  if (entry.state === 'VALIDATED') transition(entry, 'QUEUED', { last_result: 'NEW_REVISION' });
  return true;
}

export function nextCandidateId(state) {
  state.candidate_counter += 1;
  return `rc-${String(state.candidate_counter).padStart(3, '0')}`;
}

/**
 * Applies a candidate-builder outcome to the queue.
 * result: { status, first_failing_pr?, passed_prs?, detail?, stale_prs?: {n: currentSha},
 *           candidate_sha?, candidate_tree_sha?, base_main_sha?, note? }
 * Only entries still VALIDATING for this candidate change state; PRs held or removed while the
 * candidate ran keep their state and only get the result recorded.
 */
export function applyResult(state, result) {
  const cc = state.current_candidate;
  Object.assign(cc, {
    status: result.status,
    finished_at: new Date().toISOString(),
    first_failing_pr: result.first_failing_pr ?? null,
    passed_prs: result.passed_prs ?? [],
    candidate_sha: result.candidate_sha ?? null,
    candidate_tree_sha: result.candidate_tree_sha ?? null,
    base_main_sha: result.base_main_sha ?? cc.base_main_sha ?? null,
    detail: result.detail ?? null,
    note: result.note ?? null,
    run_url: result.run_url ?? cc.run_url ?? null,
  });
  const failing = result.first_failing_pr;
  const failIndex = failing ? cc.prs.indexOf(failing) : -1;
  const changed = [];

  cc.prs.forEach((number, i) => {
    const entry = findEntry(state, number);
    if (!entry) return;
    let next;
    let lastResult;
    let detail = null;
    switch (result.status) {
      case 'VALIDATED':
        [next, lastResult] = ['VALIDATED', 'PASS'];
        break;
      case 'STALE_PR':
        if (result.stale_prs?.[number]) {
          [next, lastResult] = ['STALE_PR', 'STALE_PR'];
        } else {
          [next, lastResult] = ['QUEUED', 'STALE (another PR changed)'];
        }
        break;
      case 'STALE_MAIN':
        [next, lastResult] = ['STALE_MAIN', 'STALE_MAIN'];
        break;
      default:
        if (failIndex < 0) {
          [next, lastResult] = ['QUEUED', result.status];
        } else if (i < failIndex) {
          [next, lastResult] = ['VALIDATED', 'PASS'];
        } else if (i === failIndex) {
          next = ['TEST_FAILED', 'MERGE_CONFLICT'].includes(result.status)
            ? result.status
            : 'BLOCKED';
          lastResult = result.status;
          detail = result.detail ?? null;
        } else {
          [next, lastResult] = ['QUEUED', `NOT RUN (stopped at #${failing})`];
        }
    }
    entry.last_candidate = cc.id;
    entry.last_result = lastResult;
    entry.result_detail = detail;
    entry.result_sha = cc.shas?.[number] ?? entry.head_sha; // the revision this result is about
    if (entry.state !== 'VALIDATING') return;
    const patch = { state_reason: next === 'BLOCKED' ? `${result.status} in ${cc.id}` : null };
    if (next === 'STALE_PR') {
      patch.new_revision = {
        from: entry.result_sha,
        to: result.stale_prs[number],
        at: new Date().toISOString(),
      };
    }
    transition(entry, next, patch);
    changed.push(number);
  });
  return changed;
}
