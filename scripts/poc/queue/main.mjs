#!/usr/bin/env node
// POC release queue manager. Handles one GitHub event per run:
//   issue_comment    `/queue …` commands on PRs or on the queue issue
//   workflow_run     a finished candidate-builder run (reads its artifacts)
//   workflow_dispatch  re-process a candidate run by id (fallback for workflow_run)
//   pull_request     a queued PR was closed/merged or got new commits
// It only changes queue metadata (issue body, labels, comments) and dispatches the existing
// candidate builder. It never merges, pushes, or changes code.
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
  ACTIVE,
  activeEntries,
  addEntry,
  applyNewRevision,
  applyResult,
  BLOCKING,
  CANDIDATE_ID,
  COMMANDS,
  composition,
  emptyState,
  findEntry,
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
  queueLine,
  recordHistory,
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
const IGNORED_ACTORS = new Set((process.env.QUEUE_IGNORED_ACTORS ?? '').split(',').filter(Boolean));
const VALIDATING_TIMEOUT_MS = 60 * 60 * 1000; // candidate builder times out at 45 minutes
const SERVER = process.env.GITHUB_SERVER_URL ?? 'https://github.com';

const summary = (md) =>
  process.env.GITHUB_STEP_SUMMARY && appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + '\n');
const refs = (numbers) => numbers.map((n) => `#${n}`).join(',');
const short = (sha) => sha?.slice(0, 12);

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

/** Persists state + dashboard, then brings labels and sticky comments in line with it. */
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
  if (refreshed)
    await api('PATCH', `${REPO}/issues/${ctx.issue.number}`, { body: renderDashboard(ctx.state) });
}

const prInfo = (pr) => ({
  number: pr.number,
  title: pr.title,
  author: pr.user.login,
  branch: pr.head.ref,
  head_sha: pr.head.sha,
});

/** Re-reads a PR; closed/merged PRs leave the queue. Returns the PR, or null if it is gone. */
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
      `PR #${entry.number} changed while queued. Queued SHA: \`${short(before)}\`, current SHA: \`${short(pr.head.sha)}\` (NEW_REVISION).`,
    );
  }
  return pr;
}

// ---- Commands ----
async function handleComment() {
  const { comment: c, issue } = ev;
  const user = c.user.login;
  if (c.user.type === 'Bot' || user.endsWith('[bot]') || IGNORED_ACTORS.has(user))
    return console.log(`Ignoring comment by ${user}.`);
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

  switch (cmd.name) {
    case 'status': {
      if (onPr && !entry)
        return finish(
          `PR #${target} is not in the release queue. Use \`/queue add\` to join.\n\n${renderStatus(state, null)}`,
        );
      op.outcome = 'READ-ONLY';
      return finish(renderStatus(state, entry));
    }

    case 'add': {
      if (!target)
        return reject('Use `/queue add` on a PR, or `/queue add #PR` on the queue issue.');
      const pr = await getPr(target);
      if (!pr) return reject(`PR #${target} does not exist.`);
      if (pr.state !== 'open') return reject(`PR #${target} is not open.`);
      if (pr.draft) return reject(`PR #${target} is a draft. Mark it ready for review first.`);
      if (pr.base.ref !== BASE)
        return reject(`PR #${target} targets \`${pr.base.ref}\` instead of \`${BASE}\`.`);
      if (entry && !INACTIVE.has(entry.state))
        return reject(`PR #${target} is already in the queue (${entry.state}).`);
      op.prev = entry?.state ?? 'NOT_QUEUED';
      if (state.frozen) {
        addEntry(state, prInfo(pr), user, 'READY');
        op.next = 'READY';
        op.outcome = 'DEFERRED';
        recordHistory(state, { op: 'ADD (frozen → READY)', pr: target, by: user });
        touched.add(target);
        await save(ctx, touched);
        return finish(
          `Queue is currently frozen.\n\nThis PR will not be added to the active candidate. It is marked \`queue:ready\` and will be queued when the queue is unfrozen.`,
          'eyes',
        );
      }
      addEntry(state, prInfo(pr), user, 'QUEUED');
      op.next = 'QUEUED';
      recordHistory(state, { op: 'ADD', pr: target, by: user });
      touched.add(target);
      break;
    }

    case 'remove': {
      if (!entry || INACTIVE.has(entry.state)) return reject(`PR #${target} is not in the queue.`);
      op.prev = transition(entry, 'REMOVED', { state_reason: `removed by @${user}` });
      op.next = 'REMOVED';
      if (op.prev === 'VALIDATING')
        notes.push(
          `#${target} was in the validating candidate; its result will be recorded but it stays removed.`,
        );
      recordHistory(state, { op: 'REMOVE', pr: target, by: user });
      touched.add(target);
      break;
    }

    case 'hold': {
      if (!entry || !(ACTIVE.has(entry.state) || entry.state === 'READY')) {
        return reject(
          `PR #${target} is not in the active queue${entry ? ` (${entry.state})` : ''}.`,
        );
      }
      op.prev = transition(entry, 'HELD', { state_reason: `held by @${user}` });
      op.next = 'HELD';
      recordHistory(state, { op: 'HOLD', pr: target, by: user, detail: `was ${op.prev}` });
      touched.add(target);
      break;
    }

    case 'resume': {
      if (entry?.state !== 'HELD')
        return reject(`PR #${target} is not held${entry ? ` (${entry.state})` : ''}.`);
      if (state.frozen)
        return reject(
          'Queue is currently frozen.\n\nThis PR will not be added to the active candidate. It stays held; `/queue resume` again after `/queue unfreeze`.',
        );
      if (!(await refreshEntry(entry, notes))) {
        touched.add(target);
        op.outcome = 'REJECTED';
        break;
      }
      op.prev = transition(entry, 'QUEUED', { state_reason: null });
      op.next = 'QUEUED';
      moveToEnd(state, entry);
      recordHistory(state, { op: 'RESUME', pr: target, by: user });
      touched.add(target);
      break;
    }

    case 'retry': {
      if (!entry || !BLOCKING.has(entry.state)) {
        return reject(
          `\`/queue retry\` applies to PRs in TEST_FAILED, MERGE_CONFLICT, STALE_PR or BLOCKED; PR #${target} is ${entry?.state ?? 'not queued'}.`,
        );
      }
      const failedSha = entry.result_sha ?? entry.head_sha;
      const pr = await getPr(target);
      if (!pr || pr.state !== 'open') {
        await refreshEntry(entry, notes);
        touched.add(target);
        op.outcome = 'REJECTED';
        break;
      }
      if (pr.head.sha !== failedSha) {
        notes.push(
          `New PR head detected.\n\nPrevious: \`${short(failedSha)}\`\n\nCurrent: \`${short(pr.head.sha)}\``,
        );
        entry.new_revision = { from: failedSha, to: pr.head.sha, at: new Date().toISOString() };
      } else {
        notes.push(
          `No new commits since the failure (\`${short(failedSha)}\`). The same combination will likely fail again unless another PR changed.`,
        );
      }
      entry.head_sha = pr.head.sha;
      entry.title = pr.title;
      op.prev = transition(entry, 'QUEUED', { state_reason: null, result_detail: null });
      op.next = 'QUEUED';
      recordHistory(state, { op: 'RETRY', pr: target, by: user, detail: `was ${op.prev}` });
      touched.add(target);
      break;
    }

    case 'move': {
      const pos = Number(cmd.args.find((a) => /^\d+$/.test(a)));
      if (!target || !pos)
        return reject('Usage: `/queue move #PR POSITION` (for example `/queue move #5 2`).');
      if (state.frozen)
        return reject('Queue is currently frozen. The active candidate order cannot change.');
      if (!entry || !ACTIVE.has(entry.state))
        return reject(`PR #${target} is not in the active queue.`);
      const before = activeEntries(state).indexOf(entry) + 1;
      moveEntry(state, entry, pos);
      op.message = `Moved #${target} from position ${before} to ${activeEntries(state).indexOf(entry) + 1}.`;
      recordHistory(state, { op: 'MOVE', pr: target, by: user, detail: op.message });
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
          transition(e, 'QUEUED', { state_reason: null });
          moveToEnd(state, e);
          touched.add(e.number);
        }
        if (ready.length)
          notes.push(`Queued PRs that were waiting: ${refs(ready.map((e) => e.number))}.`);
      }
      recordHistory(state, { op: cmd.name.toUpperCase(), by: user });
      op.message = freezing
        ? 'Queue is now FROZEN: `/queue add`, `/queue resume` and `/queue move` will not change the active candidate.'
        : 'Queue is now OPEN.';
      break;
    }

    case 'build':
      return build(ctx, cmd, op, finish, reject);
  }

  await save(ctx, touched);
  const message = [op.message, ...notes].filter(Boolean).join('\n\n');
  if (message) op.message = message;
  // Plain successes are acknowledged with a reaction; anything with extra information gets a reply.
  return finish(message || null);
}

async function build(ctx, cmd, op, finish, reject) {
  const { state } = ctx;
  const explicitId = cmd.args[0];
  if (explicitId && !CANDIDATE_ID.test(explicitId))
    return reject(`Invalid candidate id \`${explicitId}\` (letters, digits, \`.\`, \`_\`, \`-\`).`);
  const touched = new Set();
  const notes = [];
  const cc = state.current_candidate;
  if (cc?.status === 'VALIDATING') {
    if (Date.now() - Date.parse(cc.started_at) < VALIDATING_TIMEOUT_MS) {
      return reject(
        `Candidate **${cc.id}** is still validating (started ${cc.started_at}). Wait for its result before building again.`,
      );
    }
    cc.status = 'ABANDONED';
    cc.note = 'No result arrived within 60 minutes.';
    for (const e of state.entries.filter((x) => x.state === 'VALIDATING')) {
      transition(e, 'QUEUED');
      touched.add(e.number);
    }
    notes.push(`Candidate ${cc.id} produced no result within 60 minutes and was marked ABANDONED.`);
  }

  // Refresh every active PR: closed/merged PRs leave, drafts/retargeted PRs block, new heads are shown.
  for (const e of activeEntries(state)) {
    const pr = await refreshEntry(e, notes);
    touched.add(e.number);
    if (pr && (pr.draft || pr.base.ref !== BASE) && !BLOCKING.has(e.state)) {
      transition(e, 'BLOCKED', {
        state_reason: pr.draft ? 'PR is a draft' : `PR targets ${pr.base.ref}`,
      });
    }
  }

  const { prs, blockers } = composition(state);
  if (blockers.length || !prs.length) {
    await save(ctx, touched);
    if (!prs.length && !blockers.length)
      return reject(
        ['Nothing to build: the active queue has no buildable PRs.', ...notes].join('\n\n'),
      );
    const b = refs(blockers.map((e) => e.number));
    return reject(
      [
        `Build rejected: ${blockers.map((e) => `#${e.number} is ${e.state}`).join(', ')}. The queue is never changed automatically.`,
        `Suggested next candidate if ${b} ${blockers.length > 1 ? 'are' : 'is'} held: **${refs(prs.map((e) => e.number)) || '(empty)'}**`,
        `Available actions on ${b}: \`/queue hold\`, \`/queue retry\`, \`/queue remove\` (on the PR, or here with \`#PR\`).`,
        ...notes,
      ].join('\n\n'),
    );
  }

  const id = explicitId ?? nextCandidateId(state);
  const numbers = prs.map((e) => e.number);
  const previous = new Map(prs.map((e) => [e.number, e.state]));
  for (const e of prs) {
    transition(e, 'VALIDATING');
    touched.add(e.number);
  }
  state.current_candidate = {
    id,
    prs: numbers,
    shas: Object.fromEntries(prs.map((e) => [e.number, e.head_sha])),
    status: 'VALIDATING',
    requested_by: op.by,
    started_at: new Date().toISOString(),
    finished_at: null,
    run_url: null,
    first_failing_pr: null,
    passed_prs: [],
  };
  recordHistory(state, { op: 'BUILD', by: op.by, detail: `${id}: ${refs(numbers)}` });
  op.message = `Candidate **${id}**: ${queueLine(prs)}`;
  await save(ctx, touched);

  try {
    await api('POST', `${REPO}/actions/workflows/${CANDIDATE_WORKFLOW}/dispatches`, {
      ref: ev.repository?.default_branch ?? BASE,
      inputs: { candidate_id: id, prs: numbers.join(',') },
    });
  } catch (err) {
    for (const e of prs) transition(e, previous.get(e.number));
    Object.assign(state.current_candidate, {
      status: 'DISPATCH_FAILED',
      note: err.message,
      finished_at: new Date().toISOString(),
    });
    await save(ctx, touched);
    return reject(`Could not dispatch the candidate builder: ${err.message}`);
  }
  const runs = `${SERVER}/${process.env.GITHUB_REPOSITORY}/actions/workflows/${CANDIDATE_WORKFLOW}`;
  return finish(
    [
      `Candidate **${id}** dispatched with ${queueLine(prs)} (\`prs=${numbers.join(',')}\`).`,
      `Follow it in [Actions](${runs}). This issue and the PRs update when it finishes.`,
      ...notes,
    ].join('\n\n'),
  );
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
  applyResult(ctx.state, result);
  recordHistory(ctx.state, {
    op: 'RESULT',
    by: 'candidate-builder',
    detail: `${id}: ${result.status}`,
  });

  // Supplementary annotations on this run.
  const d = result.detail;
  if (d?.type === 'MERGE_CONFLICT') {
    const peers = d.direct_conflicts_with.length ? ` with PR ${refs(d.direct_conflicts_with)}` : '';
    for (const f of d.conflicting_files)
      console.log(
        `::error file=${f}::PR #${result.first_failing_pr} conflicts${peers} in release candidate ${id}`,
      );
  }
  if (d?.type === 'TEST_FAILED') {
    for (const f of new Set([d.throw_site, ...d.failed_tests.map((t) => t.file)].filter(Boolean))) {
      console.log(
        `::error file=${f}::Candidate ${id} tests failed after adding PR #${result.first_failing_pr}`,
      );
    }
  }
  await save(ctx, new Set(cc.prs));
  summary(renderResultSummary(ctx.state));
}

// ---- PR lifecycle ----
async function handlePrEvent() {
  const pr = ev.pull_request;
  const ctx = await loadQueue({ create: false });
  const entry = ctx && findEntry(ctx.state, pr.number);
  if (!entry || INACTIVE.has(entry.state))
    return console.log(`PR #${pr.number} is not in the queue.`);
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
    const before = entry.head_sha;
    if (!applyNewRevision(entry, pr.head.sha)) return console.log('Head SHA unchanged.');
    op.message = `NEW_REVISION: \`${short(before)}\` → \`${short(pr.head.sha)}\``;
  }
  entry.title = pr.title;
  op.next = entry.state;
  recordHistory(ctx.state, {
    op: `PR ${ev.action.toUpperCase()}`,
    pr: pr.number,
    by: op.by,
    detail: op.message ?? entry.state,
  });
  await save(ctx, new Set([pr.number]));
  summary(renderOperationSummary(ctx.state, op));
}

// ---- Entry point ----
try {
  if (EVENT === 'issue_comment') await handleComment();
  else if (EVENT === 'workflow_run') await handleResult(ev.workflow_run);
  else if (EVENT === 'workflow_dispatch')
    await handleResult(await api('GET', `${REPO}/actions/runs/${ev.inputs.result_run_id}`));
  else if (EVENT === 'pull_request') await handlePrEvent();
  else console.log(`Unhandled event ${EVENT}.`);
} catch (err) {
  console.log(`::error::${err.message}`);
  summary(`# Queue Manager Error\n\n${err.message}`);
  process.exit(1);
}
