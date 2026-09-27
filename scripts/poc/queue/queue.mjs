// Pure release-queue logic: the state model, command parsing and state transitions.
// No GitHub API calls here, so everything in this file is unit-testable.
//
// The queue validates itself continuously: every change to the set of queued PRs (or to main)
// bumps `revision`, and the newest revision is always the one being validated.

/** In the queue: every one of these is part of the next candidate, in order. */
export const IN_QUEUE = new Set(['QUEUED', 'VALIDATING', 'VALIDATED']);
/** Ejected: out of candidates until `/queue retry` (same place) or `/queue add` (end). */
export const EJECTED = new Set(['TEST_FAILED', 'MERGE_CONFLICT', 'STALE_PR', 'BLOCKED']);
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
  BLOCKED: 'queue:blocked',
};
export const LABEL_COLORS = {
  'queue:ready': ['c5def5', 'Waiting for the queue to unfreeze'],
  'queue:queued': ['fbca04', 'Queued; waiting for the next candidate'],
  'queue:validating': ['1d76db', 'Part of the candidate being validated'],
  'queue:validated': ['0e8a16', 'Validated with the current queue'],
  'queue:held': ['bfd4f2', 'Held: excluded from candidates'],
  'queue:test-failed': ['d73a4a', 'Ejected: tests failed in the candidate'],
  'queue:merge-conflict': ['b60205', 'Ejected: merge conflict in the candidate'],
  'queue:stale': ['e99695', 'Ejected: new commits; /queue retry or /queue add'],
  'queue:blocked': ['5319e7', 'Ejected: needs developer action'],
  'release-queue': ['0052cc', 'POC release queue dashboard'],
};

export const MUTATING = new Set([
  'add',
  'remove',
  'hold',
  'resume',
  'retry',
  'move',
  'revalidate',
  'freeze',
  'unfreeze',
]);
export const QUEUE_ISSUE_ONLY = new Set(['revalidate', 'freeze', 'unfreeze']);
export const COMMANDS = [
  'add',
  'remove',
  'hold',
  'resume',
  'retry',
  'status',
  'move',
  'revalidate',
  'freeze',
  'unfreeze',
];

const HISTORY_LIMIT = 15;
const INACTIVE_LIMIT = 20;

export function emptyState() {
  return {
    version: 2,
    frozen: false,
    frozen_by: null,
    frozen_at: null,
    revision: 0,
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
  const state = JSON.parse(body.slice(start + STATE_START.length, end));
  return { ...emptyState(), ...state }; // fills fields added in later versions
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
export const queueEntries = (state) => state.entries.filter((e) => IN_QUEUE.has(e.state));
export const positionOf = (state, number) => {
  const i = queueEntries(state).findIndex((e) => e.number === number);
  return i < 0 ? null : i + 1;
};
export const queueLine = (entries) => entries.map((e) => `#${e.number}`).join(' → ') || '(empty)';

/** Identifies what would be validated: the queued PRs, in order, at their head SHAs. */
export const signature = (state) =>
  queueEntries(state)
    .map((e) => `${e.number}@${e.head_sha}`)
    .join(',');

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
    result_sha: null,
    new_revision: null,
    state_reason: null,
    comment_id: existing?.comment_id ?? null,
    comment_hash: null,
    updated_at: new Date().toISOString(),
  };
  state.entries.push(entry);
  return entry;
}

/** Moves an entry to the end of the queue (e.g. `/queue resume`, `/queue add` after ejection). */
export function moveToEnd(state, entry) {
  state.entries.splice(state.entries.indexOf(entry), 1);
  state.entries.push(entry);
}

/** Moves a queued entry so it becomes queue position `pos` (1-based, clamped). */
export function moveEntry(state, entry, pos) {
  const others = state.entries.filter((e) => e !== entry);
  const queuedOthers = others.filter((e) => IN_QUEUE.has(e.state));
  const target = Math.max(1, pos);
  const index =
    target <= queuedOthers.length
      ? others.indexOf(queuedOthers[target - 1])
      : queuedOthers.length
        ? others.indexOf(queuedOthers.at(-1)) + 1
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

/**
 * Records a new head SHA. A queued PR pops out of the queue (STALE_PR): the author re-enters it
 * with `/queue retry` (same place) or `/queue add` (end). Returns true if the SHA changed.
 */
export function applyNewRevision(entry, sha) {
  if (!sha || sha === entry.head_sha) return false;
  entry.new_revision = { from: entry.head_sha, to: sha, at: new Date().toISOString() };
  entry.head_sha = sha;
  if (IN_QUEUE.has(entry.state)) {
    transition(entry, 'STALE_PR', { state_reason: 'new commits pushed', result_detail: null });
  }
  return true;
}

/**
 * Starts a new queue revision: everything queued must be validated again.
 * Returns the PR numbers whose state changed (for label updates).
 */
export function bumpRevision(state) {
  state.revision += 1;
  const changed = [];
  for (const e of queueEntries(state)) {
    if (e.state !== 'QUEUED') {
      transition(e, 'QUEUED');
      changed.push(e.number);
    }
  }
  return changed;
}

export function nextCandidateId(state) {
  state.candidate_counter += 1;
  return `rc-${String(state.candidate_counter).padStart(3, '0')}`;
}

/**
 * Applies a candidate-builder outcome to the queue.
 * result: { status, first_failing_pr?, passed_prs?, detail?, stale_prs?: {n: currentSha},
 *           candidate_sha?, candidate_tree_sha?, base_main_sha?, note? }
 * The first failing PR is ejected, the passing prefix is VALIDATED and the rest goes back to
 * QUEUED. Returns { changed, revalidate } where `revalidate` means the queue changed (e.g. a PR
 * was ejected) and should be validated again. PRs held or removed while the candidate ran keep
 * their state and only get the result recorded.
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
  const stale = ['STALE_PR', 'STALE_MAIN'].includes(result.status);
  let ejected = false;

  cc.prs.forEach((number, i) => {
    const entry = findEntry(state, number);
    if (!entry) return;
    let next;
    let lastResult;
    let detail = null;
    if (result.status === 'VALIDATED') {
      [next, lastResult] = ['VALIDATED', 'PASS'];
    } else if (result.status === 'STALE_PR' && result.stale_prs?.[number]) {
      [next, lastResult] = ['STALE_PR', 'STALE_PR'];
    } else if (failIndex < 0) {
      // Stale, cancelled or a failure the builder could not attribute to one PR.
      [next, lastResult] = ['QUEUED', result.status];
    } else if (i < failIndex) {
      [next, lastResult] = ['VALIDATED', 'PASS'];
    } else if (i === failIndex) {
      next = ['TEST_FAILED', 'MERGE_CONFLICT'].includes(result.status) ? result.status : 'BLOCKED';
      lastResult = result.status;
      detail = result.detail ?? null;
      // Keep the failing combination with the PR: the next candidate replaces current_candidate.
      entry.failure = {
        candidate: cc.id,
        status: result.status,
        prs: [...cc.prs],
        first_failing_pr: failing,
        passed_prs: result.passed_prs ?? [],
      };
    } else {
      [next, lastResult] = ['QUEUED', `NOT RUN (stopped at #${failing})`];
    }
    entry.last_candidate = cc.id;
    entry.last_result = lastResult;
    entry.result_detail = detail;
    entry.result_sha = cc.shas?.[number] ?? entry.head_sha; // the revision this result is about
    if (entry.state !== 'VALIDATING') return;
    const patch = {
      state_reason: EJECTED.has(next) ? `${result.status} in ${cc.id}` : null,
    };
    if (next === 'STALE_PR') {
      patch.new_revision = {
        from: entry.result_sha,
        to: result.stale_prs[number],
        at: new Date().toISOString(),
      };
      patch.head_sha = result.stale_prs[number];
    }
    transition(entry, next, patch);
    changed.push(number);
    if (EJECTED.has(next)) ejected = true;
  });
  // After an ejection the passing prefix is already validated as a candidate of its own
  // (main + prefix), so only revalidate if the queue holds something that prefix didn't cover.
  const queued = queueEntries(state);
  const revalidate =
    queued.length > 0 && (stale || (ejected && queued.some((e) => e.state !== 'VALIDATED')));
  return { changed, revalidate };
}
