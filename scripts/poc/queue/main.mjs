#!/usr/bin/env node
// POC release queue manager. The queue validates itself: every change to the queued PRs (or a
// push to main) bumps the queue revision and requests a new candidate.
//
// Event handlers (one per run):
//   issue_comment  `/queue …` commands on PRs or on the queue issue
//   pull_request   a queued PR was closed/merged or got new commits (new commits pop it out)
//   push           main changed: revalidate the queue on the new base
// Validation pipeline (a separate "validate" run of this workflow, one job per mode):
//   QUEUE_MODE=start   after a short debounce: skip if a newer revision exists, cancel the
//                      outdated candidate run, dispatch the candidate builder
//   QUEUE_MODE=await   wait for that candidate run (no queue lock held)
//   QUEUE_MODE=record  apply its result; an ejection requests the next revalidation
// It never merges, pushes, or changes code.
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import {
  api,
  canWrite,
  comment,
  ensureLabels,
  getPr,
  paginate,
  react,
  REPO,
  setQueueLabel,
  upsertSticky,
} from './github.mjs';
import {
  addEntry,
  applyNewRevision,
  applyResult,
  bumpRevision,
  COMMANDS,
  EJECTED,
  emptyState,
  findEntry,
  IN_QUEUE,
  INACTIVE,
  LABEL_COLORS,
  moveEntry,
  moveToEnd,
  MUTATING,
  nextCandidateId,
  parseCommand,
  parsePrRef,
  parseState,
  pruneInactive,
  QUEUE_ISSUE_ONLY,
  queueEntries,
  queueLine,
  recordHistory,
  signature,
  STATE_LABELS,
  transition,
} from './queue.mjs';
import {
  QUEUE_TITLE,
  renderDashboard,
  renderOperationSummary,
  renderPrComment,
  renderResultSummary,
  renderStatus,
  STICKY_MARKER,
} from './render.mjs';

const EVENT = process.env.GITHUB_EVENT_NAME;
const ev = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
const BASE = process.env.QUEUE_BASE_BRANCH ?? 'main';
const CANDIDATE_WORKFLOW = process.env.CANDIDATE_WORKFLOW ?? 'poc-candidate-builder.yml';
const QUEUE_WORKFLOW = process.env.QUEUE_WORKFLOW ?? 'poc-queue-manager.yml';
const BUILDER_NAME = 'POC - Build Release Candidate';
const IGNORED_ACTORS = new Set((process.env.QUEUE_IGNORED_ACTORS ?? '').split(',').filter(Boolean));
const REF = ev.repository?.default_branch ?? BASE;
const ACTOR = process.env.GITHUB_ACTOR ?? 'unknown';

const summary = (md) =>
  process.env.GITHUB_STEP_SUMMARY && appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + '\n');
const output = (key, value) =>
  process.env.GITHUB_OUTPUT && appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
const refs = (numbers) => numbers.map((n) => `#${n}`).join(',');
const short = (sha) => sha?.slice(0, 12);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---- Queue issue (the durable state) ----
async function loadQueue({ create }) {
  const issues = await paginate(`${REPO}/issues?labels=release-queue&state=open`);
  let issue = issues
    .filter((i) => !i.pull_request && i.title === QUEUE_TITLE)
    .sort((a, b) => a.number - b.number)[0];
  if (!issue) {
    if (!create) return null;
    await ensureLabels(LABEL_COLORS);
    const state = emptyState();
    issue = await api('POST', `${REPO}/issues`, {
      title: QUEUE_TITLE,
      labels: ['release-queue'],
      body: renderDashboard(state),
    });
    return { issue, state };
  }
  let state;
  try {
    state = parseState(issue.body);
  } catch {
    state = null;
  }
  if (!state) {
    throw new Error(
      `Queue issue #${issue.number} has no readable queue state; refusing to overwrite it. Restore the state block in its description or close it to start a new queue.`,
    );
  }
  return { issue, state };
}

const hash = (text) => createHash('sha1').update(text).digest('hex');

/**
 * Persists state + dashboard, brings labels and sticky comments in line with it, and then
 * dispatches the validation run if this change requested one.
 */
async function save(ctx, touched = new Set()) {
  pruneInactive(ctx.state);
  await api('PATCH', `${REPO}/issues/${ctx.issue.number}`, { body: renderDashboard(ctx.state) });
  let refreshed = false;
  for (const e of ctx.state.entries) {
    const isTouched = touched.has(e.number);
    if (INACTIVE.has(e.state) && !isTouched) continue;
    try {
      if (isTouched) await setQueueLabel(e.number, STATE_LABELS[e.state] ?? null);
      const meta = { dashboardUrl: ctx.issue.html_url };
      const h = hash(renderPrComment(ctx.state, e, { ...meta, now: 'fixed' }));
      if (isTouched || h !== e.comment_hash) {
        e.comment_id = await upsertSticky(
          e.number,
          STICKY_MARKER,
          renderPrComment(ctx.state, e, meta),
          e.comment_id,
        );
        e.comment_hash = h;
        refreshed = true;
      }
    } catch (err) {
      console.log(`::warning::Could not update PR #${e.number}: ${err.message}`);
    }
  }
  // Store the sticky comment ids/hashes so later runs update instead of searching.
  if (refreshed) {
    await api('PATCH', `${REPO}/issues/${ctx.issue.number}`, { body: renderDashboard(ctx.state) });
  }
  if (ctx.validation) {
    const { revision, reason } = ctx.validation;
    ctx.validation = null;
    try {
      await api('POST', `${REPO}/actions/workflows/${QUEUE_WORKFLOW}/dispatches`, {
        ref: REF,
        inputs: { revision: String(revision), reason },
      });
      console.log(`Requested validation of queue revision ${revision} (${reason}).`);
    } catch (err) {
      console.log(
        `::error::Could not start validation: ${err.message}. Run "POC - Queue Manager" manually to revalidate.`,
      );
    }
  }
}

/** Marks the queue as changed: everything queued must be validated again. */
function requestValidation(ctx, reason, touched) {
  for (const n of bumpRevision(ctx.state)) touched.add(n);
  ctx.validation = { revision: ctx.state.revision, reason };
  recordHistory(ctx.state, {
    op: 'REVALIDATE',
    by: 'queue',
    detail: `revision ${ctx.state.revision}: ${reason}`,
  });
}

/** Requests validation if the queued PRs (or their SHAs) changed since `before`. */
function revalidateIfChanged(ctx, before, reason, touched) {
  if (signature(ctx.state) === before) return false;
  requestValidation(ctx, reason, touched);
  return true;
}

const prInfo = (pr) => ({
  number: pr.number,
  title: pr.title,
  author: pr.user.login,
  branch: pr.head.ref,
  head_sha: pr.head.sha,
});

/**
 * Re-reads a PR. Closed/merged PRs leave the queue; a new head SHA pops a queued PR out.
 * Returns the PR, or null if it is gone.
 */
async function refreshEntry(entry, notes) {
  const pr = await getPr(entry.number);
  if (!pr || pr.state !== 'open') {
    transition(entry, pr?.merged ? 'MERGED' : 'REMOVED', {
      state_reason: pr?.merged ? 'merged outside the queue' : 'PR closed',
    });
    notes.push(`PR #${entry.number} is ${pr?.merged ? 'merged' : 'closed'} and left the queue.`);
    return null;
  }
  entry.title = pr.title;
  const before = entry.head_sha;
  if (applyNewRevision(entry, pr.head.sha)) {
    notes.push(
      `PR #${entry.number} has new commits (\`${short(before)}\` → \`${short(pr.head.sha)}\`)${entry.state === 'STALE_PR' ? ' and left the queue' : ''}.`,
    );
  }
  return pr;
}

/** Puts an ejected PR back into the queue, either at its old place or at the end. */
async function reenter(ctx, entry, { toEnd }, notes) {
  const failedSha = entry.result_sha ?? entry.head_sha;
  const pr = await refreshEntry(entry, notes);
  if (!pr) return false;
  if (entry.head_sha !== failedSha) {
    notes.push(
      `New PR head detected.\n\nPrevious: \`${short(failedSha)}\`\n\nCurrent: \`${short(entry.head_sha)}\``,
    );
  } else if (entry.state !== 'STALE_PR') {
    notes.push(
      `No new commits since the failure (\`${short(failedSha)}\`); it will likely fail the same way unless another PR changed.`,
    );
  }
  transition(entry, 'QUEUED', { state_reason: null, result_detail: null, failure: null });
  if (toEnd) moveToEnd(ctx.state, entry);
  return true;
}

// ---- Commands ----
async function handleComment() {
  const { comment: c, issue } = ev;
  const user = c.user.login;
  if (c.user.type === 'Bot' || user.endsWith('[bot]') || IGNORED_ACTORS.has(user)) {
    return console.log(`Ignoring comment by ${user}.`);
  }
  const cmd = parseCommand(c.body);
  if (!cmd) return console.log('Not a /queue command.');

  const mutating = MUTATING.has(cmd.name);
  const ctx = await loadQueue({ create: mutating });
  const onPr = Boolean(issue.pull_request);
  const onQueueIssue = ctx?.issue.number === issue.number;
  const op = { name: cmd.name, by: user, pr: null, outcome: 'DONE' };
  const finish = async (reply, reaction) => {
    if (reply) await comment(issue.number, reply);
    await react(c.id, reaction ?? (op.outcome === 'REJECTED' ? 'confused' : '+1'));
    summary(
      ctx
        ? renderOperationSummary(ctx.state, op)
        : `# Queue Operation\n\n${op.name}: ${op.message ?? op.outcome}`,
    );
  };
  const reject = (message) => {
    op.outcome = 'REJECTED';
    op.message = message;
    return finish(message);
  };

  if (!COMMANDS.includes(cmd.name)) {
    op.outcome = 'HELP';
    return finish(
      `Unknown queue command \`${cmd.name}\`. Available: ${COMMANDS.map((n) => `\`/queue ${n}\``).join(', ')}.`,
      'confused',
    );
  }
  if (!ctx) {
    op.message =
      'The release queue has not been created yet. It is created by the first `/queue add`.';
    return finish(op.message);
  }
  if (!onPr && !onQueueIssue) {
    return reject(
      `Queue commands work on pull requests or on the queue issue #${ctx.issue.number}.`,
    );
  }
  if (mutating && !(await canWrite(user))) {
    return reject(
      `Queue command rejected.\n\n@${user} does not have sufficient repository permission to modify the release queue.`,
    );
  }
  if (QUEUE_ISSUE_ONLY.has(cmd.name) && !onQueueIssue) {
    return reject(
      `\`/queue ${cmd.name}\` is only available on the queue issue #${ctx.issue.number}.`,
    );
  }

  const prArg = cmd.args.map(parsePrRef).find((n, i) => n && cmd.args[i].startsWith('#'));
  const target = prArg ?? (onPr ? issue.number : null);
  op.pr = target;
  const { state } = ctx;
  const entry = target ? findEntry(state, target) : null;
  const touched = new Set();
  const notes = [];
  const before = signature(state);
  const frozenMessage =
    'Queue is currently frozen.\n\nThis PR will not be added to the active candidate.';

  switch (cmd.name) {
    case 'status': {
      op.outcome = 'READ-ONLY';
      if (onPr && !entry) {
        return finish(
          `PR #${target} is not in the release queue. Use \`/queue add\` to join.\n\n${renderStatus(state, null)}`,
        );
      }
      return finish(renderStatus(state, entry));
    }

    case 'add': {
      if (!target)
        return reject('Use `/queue add` on a PR, or `/queue add #PR` on the queue issue.');
      if (entry && IN_QUEUE.has(entry.state)) {
        return reject(`PR #${target} is already in the queue (${entry.state}).`);
      }
      if (entry?.state === 'HELD') return reject(`PR #${target} is held. Use \`/queue resume\`.`);
      if (entry?.state === 'READY') {
        return reject(`PR #${target} is already waiting for the queue to unfreeze.`);
      }
      const pr = await getPr(target);
      if (!pr) return reject(`PR #${target} does not exist.`);
      if (pr.state !== 'open') return reject(`PR #${target} is not open.`);
      if (pr.draft) return reject(`PR #${target} is a draft. Mark it ready for review first.`);
      if (pr.base.ref !== BASE) {
        return reject(`PR #${target} targets \`${pr.base.ref}\` instead of \`${BASE}\`.`);
      }
      op.prev = entry?.state ?? 'NOT_QUEUED';
      if (state.frozen) {
        if (entry && EJECTED.has(entry.state)) {
          return reject(
            `${frozenMessage} It stays ${entry.state}; re-add it after \`/queue unfreeze\`.`,
          );
        }
        addEntry(state, prInfo(pr), user, 'READY');
        op.next = 'READY';
        op.outcome = 'DEFERRED';
        recordHistory(state, { op: 'ADD (frozen → READY)', pr: target, by: user });
        touched.add(target);
        await save(ctx, touched);
        return finish(
          `${frozenMessage} It is marked \`queue:ready\` and will be queued when the queue is unfrozen.`,
          'eyes',
        );
      }
      if (entry && EJECTED.has(entry.state)) {
        if (!(await reenter(ctx, entry, { toEnd: true }, notes))) {
          op.outcome = 'REJECTED';
        } else {
          notes.unshift(`#${target} rejoined the queue at the end.`);
        }
      } else {
        addEntry(state, prInfo(pr), user, 'QUEUED');
      }
      op.next = findEntry(state, target).state;
      recordHistory(state, { op: 'ADD', pr: target, by: user });
      touched.add(target);
      break;
    }

    case 'remove': {
      if (!entry || INACTIVE.has(entry.state)) return reject(`PR #${target} is not in the queue.`);
      op.prev = transition(entry, 'REMOVED', { state_reason: `removed by @${user}` });
      op.next = 'REMOVED';
      recordHistory(state, { op: 'REMOVE', pr: target, by: user });
      touched.add(target);
      break;
    }

    case 'hold': {
      if (!entry || INACTIVE.has(entry.state) || entry.state === 'HELD') {
        return reject(`PR #${target} is not in the queue${entry ? ` (${entry.state})` : ''}.`);
      }
      op.prev = transition(entry, 'HELD', { state_reason: `held by @${user}` });
      op.next = 'HELD';
      recordHistory(state, { op: 'HOLD', pr: target, by: user, detail: `was ${op.prev}` });
      touched.add(target);
      break;
    }

    case 'resume': {
      if (entry?.state !== 'HELD') {
        return reject(`PR #${target} is not held${entry ? ` (${entry.state})` : ''}.`);
      }
      if (state.frozen) {
        return reject(
          `${frozenMessage} It stays held; \`/queue resume\` again after \`/queue unfreeze\`.`,
        );
      }
      touched.add(target);
      if (!(await refreshEntry(entry, notes))) {
        op.outcome = 'REJECTED';
        break;
      }
      op.prev = transition(entry, 'QUEUED', { state_reason: null });
      op.next = 'QUEUED';
      moveToEnd(state, entry);
      recordHistory(state, { op: 'RESUME', pr: target, by: user });
      break;
    }

    case 'retry': {
      if (!entry || !EJECTED.has(entry.state)) {
        return reject(
          `\`/queue retry\` applies to ejected PRs (TEST_FAILED, MERGE_CONFLICT, STALE_PR, BLOCKED); PR #${target} is ${entry?.state ?? 'not queued'}.`,
        );
      }
      if (state.frozen) return reject(`${frozenMessage} Retry it after \`/queue unfreeze\`.`);
      op.prev = entry.state;
      touched.add(target);
      if (!(await reenter(ctx, entry, { toEnd: false }, notes))) {
        op.outcome = 'REJECTED';
        break;
      }
      op.next = 'QUEUED';
      notes.unshift(
        `#${target} is back at queue position ${queueEntries(state).indexOf(entry) + 1}.`,
      );
      recordHistory(state, { op: 'RETRY', pr: target, by: user, detail: `was ${op.prev}` });
      break;
    }

    case 'move': {
      const pos = Number(cmd.args.find((a) => /^\d+$/.test(a)));
      if (!target || !pos) {
        return reject('Usage: `/queue move #PR POSITION` (for example `/queue move #5 2`).');
      }
      if (state.frozen) return reject('Queue is currently frozen. The queue order cannot change.');
      if (!entry || !IN_QUEUE.has(entry.state)) return reject(`PR #${target} is not in the queue.`);
      const from = queueEntries(state).indexOf(entry) + 1;
      moveEntry(state, entry, pos);
      op.message = `Moved #${target} from position ${from} to ${queueEntries(state).indexOf(entry) + 1}.`;
      recordHistory(state, { op: 'MOVE', pr: target, by: user, detail: op.message });
      break;
    }

    case 'revalidate': {
      if (!queueEntries(state).length) return reject('The queue is empty; nothing to validate.');
      requestValidation(ctx, `requested by @${user}`, touched);
      op.message = `Revalidating queue revision ${state.revision}: ${queueLine(queueEntries(state))}.`;
      break;
    }

    case 'freeze':
    case 'unfreeze': {
      const freezing = cmd.name === 'freeze';
      if (state.frozen === freezing)
        return reject(`Queue is already ${freezing ? 'frozen' : 'open'}.`);
      Object.assign(state, {
        frozen: freezing,
        frozen_by: freezing ? user : null,
        frozen_at: freezing ? new Date().toISOString() : null,
      });
      if (!freezing) {
        const ready = state.entries.filter((e) => e.state === 'READY');
        for (const e of ready) {
          await refreshEntry(e, notes);
          if (e.state !== 'READY') continue;
          transition(e, 'QUEUED', { state_reason: null });
          moveToEnd(state, e);
          touched.add(e.number);
        }
        if (touched.size) notes.push(`Queued PRs that were waiting: ${refs([...touched])}.`);
      }
      recordHistory(state, { op: cmd.name.toUpperCase(), by: user });
      op.message = freezing
        ? 'Queue is now FROZEN: `/queue add`, `/queue resume`, `/queue retry` and `/queue move` are paused. Removing or holding PRs still works and revalidates the queue.'
        : 'Queue is now OPEN.';
      break;
    }
  }

  if (cmd.name !== 'revalidate') {
    const why = `${cmd.name.toUpperCase()}${target ? ` #${target}` : ''} by @${user}`;
    revalidateIfChanged(ctx, before, why, touched);
  }
  await save(ctx, touched);
  // Plain successes are acknowledged with a reaction; anything with extra information gets a
  // reply. The revalidation itself shows on the dashboard, PR comments and the job summary.
  const message = [op.message, ...notes].filter(Boolean).join('\n\n');
  op.message = [message, `Queue revision ${state.revision}: ${queueLine(queueEntries(state))}.`]
    .filter(Boolean)
    .join('\n\n');
  return finish(message || null);
}

// ---- Validation pipeline ----
/** Latest candidate-builder run for a candidate id created at/after `notBefore`, or null. */
async function findCandidateRun(candidateId, notBefore) {
  const earliest = notBefore ? Date.parse(notBefore) - 60_000 : 0; // allow for clock skew
  const { workflow_runs: runs } = await api(
    'GET',
    `${REPO}/actions/workflows/${CANDIDATE_WORKFLOW}/runs?event=workflow_dispatch&per_page=30`,
  );
  return (
    runs
      .filter((r) => r.display_title?.startsWith(`Candidate ${candidateId} (`))
      .filter((r) => Date.parse(r.created_at) >= earliest)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))[0] ?? null
  );
}

/** QUEUE_MODE=start: validate the newest queue revision (REVISION empty = manual run). */
async function startCandidate() {
  const ctx = await loadQueue({ create: false });
  if (!ctx) return summary('# Queue Validation\n\nNo queue exists yet.');
  const { state } = ctx;
  const touched = new Set();
  const notes = [];
  let reason = process.env.REASON || `manual run by @${ACTOR}`;
  const wanted = process.env.REVISION ? Number(process.env.REVISION) : null;
  if (wanted === null) {
    if (!queueEntries(state).length) return summary('# Queue Validation\n\nThe queue is empty.');
    requestValidation(ctx, reason, touched);
    ctx.validation = null; // this run validates it
  } else if (wanted !== state.revision) {
    const msg = `Revision ${wanted} is outdated (queue is at revision ${state.revision}); a newer validation run handles it.`;
    console.log(msg);
    return summary(`# Queue Validation\n\n${msg}`);
  }

  // Re-check every queued PR: closed PRs leave, new commits pop out, drafts are blocked.
  for (const e of queueEntries(state)) {
    touched.add(e.number);
    const pr = await refreshEntry(e, notes);
    if (pr && IN_QUEUE.has(e.state) && (pr.draft || pr.base.ref !== BASE)) {
      transition(e, 'BLOCKED', {
        state_reason: pr.draft ? 'PR is a draft' : `PR targets ${pr.base.ref}`,
      });
    }
  }

  // Newest candidate wins: cancel the outdated one.
  const cc = state.current_candidate;
  if (cc?.status === 'VALIDATING') {
    const run = await findCandidateRun(cc.id, cc.started_at);
    if (run && run.status !== 'completed') {
      await api('POST', `${REPO}/actions/runs/${run.id}/cancel`).catch((err) =>
        console.log(`::warning::Could not cancel run ${run.id}: ${err.message}`),
      );
    }
    Object.assign(cc, {
      status: 'SUPERSEDED',
      finished_at: new Date().toISOString(),
      note: `Superseded by queue revision ${state.revision}.`,
    });
    notes.push(`Cancelled outdated candidate ${cc.id}.`);
  }

  const prs = queueEntries(state);
  if (!prs.length) {
    recordHistory(state, {
      op: 'VALIDATE',
      by: 'queue',
      detail: 'queue empty, nothing to validate',
    });
    await save(ctx, touched);
    return summary(
      ['# Queue Validation', 'The queue is empty; nothing to validate.', ...notes].join('\n\n'),
    );
  }
  const id = nextCandidateId(state);
  const numbers = prs.map((e) => e.number);
  for (const e of prs) {
    transition(e, 'VALIDATING');
    touched.add(e.number);
  }
  state.current_candidate = {
    id,
    revision: state.revision,
    reason,
    prs: numbers,
    shas: Object.fromEntries(prs.map((e) => [e.number, e.head_sha])),
    status: 'VALIDATING',
    started_at: new Date().toISOString(),
    finished_at: null,
    run_url: null,
    first_failing_pr: null,
    passed_prs: [],
  };
  recordHistory(state, {
    op: 'VALIDATE',
    by: 'queue',
    detail: `${id}: ${refs(numbers)} (${reason})`,
  });
  await save(ctx, touched);

  try {
    await api('POST', `${REPO}/actions/workflows/${CANDIDATE_WORKFLOW}/dispatches`, {
      ref: REF,
      inputs: { candidate_id: id, prs: numbers.join(',') },
    });
  } catch (err) {
    for (const e of prs) transition(e, 'QUEUED');
    Object.assign(state.current_candidate, {
      status: 'DISPATCH_FAILED',
      note: err.message,
      finished_at: new Date().toISOString(),
    });
    await save(ctx, touched);
    throw new Error(`Could not dispatch the candidate builder: ${err.message}`);
  }
  output('candidate_id', id);
  summary(
    [
      '# Queue Validation',
      `**Candidate:** ${id} (queue revision ${state.revision})`,
      `**Reason:** ${reason}`,
      `**Queue:** ${queueLine(prs)}`,
      ...notes,
    ].join('\n\n'),
  );
}

/** QUEUE_MODE=await: wait for the candidate run; stop early if a newer candidate replaced it. */
async function awaitCandidate() {
  const candidateId = process.env.CANDIDATE_ID;
  const pollMs = Number(process.env.QUEUE_POLL_SECONDS ?? 20) * 1000;
  const deadline = Date.now() + 50 * 60 * 1000;
  for (;;) {
    const cc = (await loadQueue({ create: false }))?.state.current_candidate;
    if (cc?.id !== candidateId || cc.status !== 'VALIDATING') {
      return console.log(
        `Candidate ${candidateId} is no longer current (${cc?.id}: ${cc?.status}).`,
      );
    }
    const run = await findCandidateRun(candidateId, cc.started_at);
    if (run?.status === 'completed') {
      console.log(`Candidate run ${run.id} (${run.display_title}) finished: ${run.conclusion}.`);
      return output('run_id', run.id);
    }
    if (Date.now() > deadline)
      throw new Error(`Gave up waiting for ${candidateId} after 50 minutes.`);
    console.log(
      run
        ? `Run ${run.id} is ${run.status}; waiting…`
        : `Waiting for the ${candidateId} run to appear…`,
    );
    await sleep(pollMs);
  }
}

/** Validates a run id and returns the candidate-builder run. */
async function candidateRun(id) {
  const run = await api('GET', `${REPO}/actions/runs/${id}`, null, { allow404: true });
  if (!run) throw new Error(`Run ${id} was not found.`);
  // `run.name` is the run's display name when the workflow sets run-name; `path` identifies it.
  if (run.path?.split('@')[0] !== `.github/workflows/${CANDIDATE_WORKFLOW}`) {
    throw new Error(`Run ${id} is not a "${BUILDER_NAME}" run (${run.path}).`);
  }
  return run;
}

// ---- Candidate results ----
function findArtifact(name) {
  const dir = process.env.QUEUE_ARTIFACTS_DIR;
  if (!dir || !existsSync(dir)) return null;
  const walk = (d) =>
    readdirSync(d).flatMap((f) => {
      const p = path.join(d, f);
      return statSync(p).isDirectory() ? walk(p) : [p];
    });
  const file = walk(dir).find((p) => path.basename(p) === name);
  return file ? JSON.parse(readFileSync(file, 'utf8')) : null;
}

function testDetail(d) {
  const byFile = new Map();
  for (const t of d.failed_tests) byFile.set(t.file, [...(byFile.get(t.file) ?? []), t.name]);
  const authors = new Map(d.evidence.map((e) => [e.number, e.author]));
  const collaborators = d.interaction_identified ? d.related_prs : [d.first_failing_pr];
  return {
    type: 'TEST_FAILED',
    failed_tests: [...byFile].slice(0, 10).map(([file, tests]) => ({ file, tests })),
    error: d.failed_tests[0]?.message ?? null,
    throw_site: d.failed_tests[0]?.source_frames?.[0] ?? null,
    related_prs: d.interaction_identified ? d.related_prs : [],
    category: d.interaction_category,
    collaborators: collaborators.map((n) => ({ number: n, author: authors.get(n) })),
  };
}

function mergeDetail(d) {
  return {
    type: 'MERGE_CONFLICT',
    conflicting_files: d.conflicting_files,
    direct_conflicts_with: d.direct_conflicts_with,
    related: d.related_prs.map((r) => ({ number: r.number, pairwise_result: r.pairwise_result })),
    collaborators: d.suggested_collaborators.map((c) => ({ number: c.number, author: c.author })),
  };
}

/** Works out the candidate outcome, preferring the builder's structured artifacts. */
async function readResult(run, cc) {
  const manifest = findArtifact('candidate-manifest.json');
  if (run.conclusion === 'success' && manifest) {
    return {
      status: 'VALIDATED',
      candidate_sha: manifest.candidate_sha,
      candidate_tree_sha: manifest.candidate_tree_sha,
      base_main_sha: manifest.base_main_sha,
    };
  }
  const test = findArtifact('candidate-test-diagnosis.json');
  if (test)
    return {
      status: 'TEST_FAILED',
      first_failing_pr: test.first_failing_pr,
      passed_prs: test.passed_prs,
      detail: testDetail(test),
    };
  const merge = findArtifact('candidate-merge-diagnosis.json');
  if (merge) {
    return {
      status: 'MERGE_CONFLICT',
      first_failing_pr: merge.first_failing_pr,
      passed_prs: merge.passed_prs,
      base_main_sha: merge.base_main_sha,
      detail: mergeDetail(merge),
    };
  }
  if (run.conclusion === 'cancelled')
    return { status: 'CANCELLED', note: 'The candidate run was cancelled.' };
  if (run.conclusion === 'success')
    return { status: 'FAILED', note: 'The run succeeded but no candidate manifest was found.' };

  // No structured artifact (lint/build/install failures, stale or invalid input): use the failed step.
  const { jobs } = await api('GET', `${REPO}/actions/runs/${run.id}/jobs`);
  const job = jobs.find((j) => j.conclusion === 'failure') ?? jobs[0];
  const step = job?.steps?.find((s) => s.conclusion === 'failure')?.name ?? '';
  if (/stale/i.test(step)) {
    const stale = {};
    for (const n of cc.prs) {
      const pr = await getPr(n);
      if (pr && pr.head.sha !== cc.shas[n]) stale[n] = pr.head.sha;
    }
    return Object.keys(stale).length
      ? {
          status: 'STALE_PR',
          stale_prs: stale,
          note: `PR ${refs(Object.keys(stale))} changed while the candidate was validating.`,
        }
      : { status: 'STALE_MAIN', note: '`main` changed while the candidate was validating.' };
  }
  // The builder prints a fixed failure block; read just those lines from the job log.
  const log = job
    ? await api('GET', `${REPO}/actions/jobs/${job.id}/logs`, null, { raw: true }).catch(() => '')
    : '';
  const lines = log.split('\n').map((l) => l.replace(/^\S+Z /, '').trim());
  const after = (label) => {
    const i = lines.indexOf(label);
    return i < 0 ? null : lines[i + 1];
  };
  const type = after('Failure type:');
  const failing = /^#(\d+)/.exec(after('Failure introduced while adding:') ?? '')?.[1];
  if (type && failing) {
    return {
      status: type,
      first_failing_pr: Number(failing),
      passed_prs: [...(after('Passed combination:') ?? '').matchAll(/#(\d+)/g)].map((m) =>
        Number(m[1]),
      ),
      note: `${type}: details are in the candidate run log.`,
    };
  }
  if (step === 'Validate PR input') {
    return {
      status: 'INVALID_INPUT',
      note: lines.filter((l) => l.startsWith('ERROR:')).join(' ') || 'Input validation failed.',
    };
  }
  return {
    status: 'FAILED',
    note: `The candidate run failed at step "${step || 'unknown'}"; see the run.`,
  };
}

/** QUEUE_MODE=record: apply a finished candidate run to the queue. */
async function handleResult(run) {
  const id = /^Candidate (\S+) \(PRs /.exec(run.display_title ?? '')?.[1];
  const ctx = await loadQueue({ create: false });
  const cc = ctx?.state.current_candidate;
  if (!ctx || !id || cc?.id !== id || cc.status !== 'VALIDATING') {
    const why = `Candidate run "${run.display_title}" is not the queue's validating candidate (${cc ? `${cc.id}: ${cc.status}` : 'none'}); nothing to update.`;
    console.log(why);
    return summary(`# Candidate Result\n\n${why}`);
  }
  cc.run_url = run.html_url;
  const result = { ...(await readResult(run, cc)), run_url: run.html_url };
  const { revalidate } = applyResult(ctx.state, result);
  recordHistory(ctx.state, {
    op: 'RESULT',
    by: 'candidate-builder',
    detail: `${id}: ${result.status}`,
  });
  const touched = new Set(cc.prs);
  if (revalidate) {
    const why = result.first_failing_pr
      ? `#${result.first_failing_pr} ejected (${result.status} in ${id})`
      : `${id} was ${result.status}`;
    requestValidation(ctx, why, touched);
  }

  // Supplementary annotations on this run.
  const d = result.detail;
  if (d?.type === 'MERGE_CONFLICT') {
    const peers = d.direct_conflicts_with.length ? ` with PR ${refs(d.direct_conflicts_with)}` : '';
    for (const f of d.conflicting_files) {
      console.log(
        `::error file=${f}::PR #${result.first_failing_pr} conflicts${peers} in release candidate ${id}`,
      );
    }
  }
  if (d?.type === 'TEST_FAILED') {
    for (const f of new Set([d.throw_site, ...d.failed_tests.map((t) => t.file)].filter(Boolean))) {
      console.log(
        `::error file=${f}::Candidate ${id} tests failed after adding PR #${result.first_failing_pr}`,
      );
    }
  }
  await save(ctx, touched);
  summary(renderResultSummary(ctx.state));
}

// ---- PR and main changes ----
async function handlePrEvent() {
  const pr = ev.pull_request;
  const ctx = await loadQueue({ create: false });
  const entry = ctx && findEntry(ctx.state, pr.number);
  if (!entry || INACTIVE.has(entry.state))
    return console.log(`PR #${pr.number} is not in the queue.`);
  const before = signature(ctx.state);
  const op = {
    name: `pr ${ev.action}`,
    by: ev.sender?.login ?? 'unknown',
    pr: pr.number,
    prev: entry.state,
  };
  if (ev.action === 'closed') {
    transition(entry, pr.merged ? 'MERGED' : 'REMOVED', {
      state_reason: pr.merged ? 'merged outside the queue' : 'PR closed without merging',
    });
  } else {
    const from = entry.head_sha;
    if (!applyNewRevision(entry, pr.head.sha)) return console.log('Head SHA unchanged.');
    op.message = `NEW_REVISION: \`${short(from)}\` → \`${short(pr.head.sha)}\``;
  }
  entry.title = pr.title;
  op.next = entry.state;
  const touched = new Set([pr.number]);
  recordHistory(ctx.state, {
    op: `PR ${ev.action.toUpperCase()}`,
    pr: pr.number,
    by: op.by,
    detail: op.message ?? entry.state,
  });
  revalidateIfChanged(
    ctx,
    before,
    `PR #${pr.number} ${ev.action === 'closed' ? 'closed' : 'has new commits'}`,
    touched,
  );
  await save(ctx, touched);
  summary(renderOperationSummary(ctx.state, op));
}

async function handlePush() {
  const ctx = await loadQueue({ create: false });
  if (!ctx || !queueEntries(ctx.state).length)
    return console.log('Queue is empty; nothing to revalidate.');
  const touched = new Set();
  requestValidation(ctx, `main updated to ${short(ev.after)}`, touched);
  await save(ctx, touched);
  summary(
    renderOperationSummary(ctx.state, {
      name: 'main updated',
      by: ev.pusher?.name ?? ACTOR,
      message: `Revalidating the queue on \`${short(ev.after)}\`.`,
    }),
  );
}

// ---- Entry point ----
try {
  const mode = process.env.QUEUE_MODE;
  if (mode === 'start') await startCandidate();
  else if (mode === 'await') await awaitCandidate();
  else if (mode === 'record') await handleResult(await candidateRun(process.env.RESULT_RUN_ID));
  else if (EVENT === 'issue_comment') await handleComment();
  else if (EVENT === 'pull_request') await handlePrEvent();
  else if (EVENT === 'push') await handlePush();
  else console.log(`Unhandled event ${EVENT}.`);
} catch (err) {
  console.log(`::error::${err.message}`);
  summary(`# Queue Manager Error\n\n${err.message}`);
  process.exit(1);
}
