// Markdown for the queue dashboard issue, PR sticky comments and job summaries.
import {
  activeEntries,
  composition,
  INACTIVE,
  positionOf,
  queueLine,
  serializeState,
} from './queue.mjs';

export const STICKY_MARKER = '<!-- POC_QUEUE_STATUS -->';
export const QUEUE_TITLE = 'POC Release Queue';

const BADGES = {
  READY: '⏳ READY',
  QUEUED: '🟡 QUEUED',
  VALIDATING: '🔄 VALIDATING',
  VALIDATED: '✅ VALIDATED',
  HELD: '⏸️ HELD',
  TEST_FAILED: '❌ TEST_FAILED',
  MERGE_CONFLICT: '❌ MERGE_CONFLICT',
  STALE_PR: '⚠️ STALE_PR',
  STALE_MAIN: '⚠️ STALE_MAIN',
  BLOCKED: '⛔ BLOCKED',
  REMOVED: '🗑️ REMOVED',
  MERGED: '🟣 MERGED',
};
export const badge = (state) => BADGES[state] ?? state;
const short = (sha) => (sha ? `\`${sha.slice(0, 12)}\`` : '—');
const cell = (text) =>
  String(text ?? '')
    .replaceAll('|', '\\|')
    .replaceAll('\n', ' ');
export const time = (iso) => (iso ? `${iso.slice(0, 16).replace('T', ' ')} UTC` : '—');
const refs = (numbers) => numbers.map((n) => `#${n}`).join(',');
const revision = (e) =>
  e.new_revision
    ? ` 🆕 NEW_REVISION ${short(e.new_revision.from)} → ${short(e.new_revision.to)}`
    : '';

/** One-line "potential interaction" text for a failure detail, or null. */
export function interaction(detail, failing) {
  if (!detail) return null;
  const others =
    detail.type === 'MERGE_CONFLICT' ? detail.direct_conflicts_with : detail.related_prs;
  const peers = (others ?? []).filter((n) => n !== failing);
  return peers.length ? peers.map((n) => `#${n} ↔ #${failing}`).join(', ') : null;
}

/** Bullet lines describing a TEST_FAILED / MERGE_CONFLICT detail. */
function detailLines(detail, failing) {
  if (!detail) return [];
  const lines = [];
  if (detail.type === 'TEST_FAILED') {
    for (const f of detail.failed_tests ?? []) {
      lines.push(
        `- Failed tests in \`${f.file}\`: ${f.tests.slice(0, 5).map(cell).join('; ')}${f.tests.length > 5 ? ` (+${f.tests.length - 5} more)` : ''}`,
      );
    }
    if (detail.error) lines.push(`- Error: \`${cell(detail.error)}\``);
    lines.push(
      `- Potential interaction: ${interaction(detail, failing) ?? 'no clear PR interaction identified automatically'}`,
    );
    if (detail.category) lines.push(`- Potential category: ${detail.category}`);
  }
  if (detail.type === 'MERGE_CONFLICT') {
    lines.push(
      `- Conflicting files: ${detail.conflicting_files.map((f) => `\`${f}\``).join(', ')}`,
    );
    lines.push(
      `- Direct pairwise conflict: ${interaction(detail, failing) ?? 'none reproduced pairwise'}`,
    );
    const overlap = (detail.related ?? []).map((r) => `#${r.number} (${r.pairwise_result})`);
    if (overlap.length) lines.push(`- Earlier PRs touching these files: ${overlap.join(', ')}`);
  }
  if (detail.collaborators?.length) {
    lines.push(
      `- Suggested collaborators: ${detail.collaborators.map((c) => `@${c.author} (#${c.number})`).join(', ')}`,
    );
  }
  return lines;
}

function candidateLines(cc) {
  if (!cc) return ['_No candidate has been built yet._'];
  const lines = [
    `**${cc.id}** — ${badge(cc.status) ?? cc.status} · ${queueLine(cc.prs.map((number) => ({ number })))}`,
  ];
  lines.push(
    '',
    `Started ${time(cc.started_at)} by @${cc.requested_by}${cc.finished_at ? ` · finished ${time(cc.finished_at)}` : ''}${cc.run_url ? ` · [run](${cc.run_url})` : ''}`,
  );
  if (cc.status === 'VALIDATED') {
    lines.push(
      '',
      `Candidate SHA: ${short(cc.candidate_sha)} · tree ${short(cc.candidate_tree_sha)} · base main ${short(cc.base_main_sha)}`,
    );
  }
  if (cc.first_failing_pr) {
    const rest = cc.prs.slice(cc.prs.indexOf(cc.first_failing_pr) + 1);
    lines.push(
      '',
      `First failing addition: **#${cc.first_failing_pr}** (${cc.status}) · validated prefix: ${refs(cc.passed_prs) || 'none'} · not run: ${refs(rest) || 'none'}`,
    );
  }
  if (cc.note) lines.push('', `Note: ${cc.note}`);
  return lines;
}

/** Cumulative validation lines for a candidate, as seen by a PR comment. */
function validationLines(cc) {
  if (
    !cc ||
    ![
      'VALIDATED',
      'TEST_FAILED',
      'MERGE_CONFLICT',
      'LINT_FAILED',
      'BUILD_FAILED',
      'INSTALL_FAILED',
      'MERGE_FAILED',
    ].includes(cc.status)
  )
    return [];
  const failIndex = cc.first_failing_pr ? cc.prs.indexOf(cc.first_failing_pr) : -1;
  return cc.prs.map((_, i) => {
    const label = `main + ${cc.prs
      .slice(0, i + 1)
      .map((n) => `#${n}`)
      .join(' + ')}`;
    if (failIndex < 0 || i < failIndex) return `- ✅ ${label}`;
    if (i === failIndex) return `- ❌ ${label} — ${cc.status}`;
    return `- ⏸️ ${label} — not run`;
  });
}

export function renderDashboard(state, meta = {}) {
  const active = activeEntries(state);
  const { prs, blockers, validating } = composition(state);
  const held = state.entries.filter((e) => e.state === 'HELD');
  const ready = state.entries.filter((e) => e.state === 'READY');
  const inactive = state.entries
    .filter((e) => INACTIVE.has(e.state))
    .slice(-10)
    .reverse();
  const md = [`# ${QUEUE_TITLE}`, ''];
  md.push(
    '> Managed by the **POC Queue Manager** workflow. Comment `/queue …` commands on this issue or on a PR. Do not edit this description by hand: the queue state is stored in it.',
    '',
  );
  md.push(
    `**Queue status:** ${state.frozen ? `🧊 FROZEN (by @${state.frozen_by}, ${time(state.frozen_at)})` : '🟢 OPEN'}`,
    '',
  );
  md.push(`**Last updated:** ${time(meta.now ?? new Date().toISOString())}`, '');

  md.push('## Current candidate', '', ...candidateLines(state.current_candidate), '');

  md.push('## Active queue', '');
  if (active.length) {
    md.push(
      '| Pos | PR | Title | Author | Head SHA | State | Last result |',
      '|---|---|---|---|---|---|---|',
    );
    active.forEach((e, i) => {
      const last = e.last_result
        ? `${e.last_result}${e.last_candidate ? ` (${e.last_candidate})` : ''}`
        : 'waiting';
      md.push(
        `| ${i + 1} | #${e.number} | ${cell(e.title)} | @${e.author} | ${short(e.head_sha)}${revision(e)} | ${badge(e.state)} | ${cell(last)} |`,
      );
    });
  } else {
    md.push('_No PRs in the active queue._');
  }
  md.push('');

  if (blockers.length) {
    md.push('## Current blocker' + (blockers.length > 1 ? 's' : ''), '');
    for (const b of blockers) {
      md.push(
        `**#${b.number} ${cell(b.title)}** — ${badge(b.state)}${b.state_reason ? ` (${b.state_reason})` : ''}`,
      );
      md.push(...detailLines(b.result_detail, b.number), '');
    }
  }

  md.push('## Next candidate', '');
  if (validating.length) {
    md.push(
      `A candidate is validating (${refs(validating.map((e) => e.number))}); wait for its result before building again.`,
    );
  } else if (blockers.length) {
    md.push(
      `\`/queue build\` is blocked by ${refs(blockers.map((e) => e.number))}. The queue is never changed automatically.`,
      '',
    );
    md.push(
      `Suggested next candidate if ${refs(blockers.map((e) => e.number))} ${blockers.length > 1 ? 'are' : 'is'} held: **${refs(prs.map((e) => e.number)) || '(empty)'}**`,
      '',
    );
    md.push(
      `Available actions on ${refs(blockers.map((e) => e.number))}: \`/queue hold\` · \`/queue retry\` · \`/queue remove\``,
    );
  } else if (prs.length) {
    md.push(`If \`/queue build\` ran now: **${refs(prs.map((e) => e.number))}**`);
  } else {
    md.push('Nothing to build.');
  }
  md.push('');

  if (held.length) {
    md.push('## Held', '', '| PR | Title | Author | Head SHA | Since |', '|---|---|---|---|---|');
    for (const e of held)
      md.push(
        `| #${e.number} | ${cell(e.title)} | @${e.author} | ${short(e.head_sha)} | ${time(e.updated_at)} |`,
      );
    md.push('');
  }
  if (ready.length) {
    md.push(
      '## Waiting for unfreeze',
      '',
      'These PRs asked to join while the queue was frozen and will be queued on `/queue unfreeze`.',
      '',
    );
    for (const e of ready)
      md.push(`- #${e.number} ${cell(e.title)} (@${e.author}) ${short(e.head_sha)}`);
    md.push('');
  }
  if (inactive.length) {
    md.push('## Recently removed or merged', '');
    for (const e of inactive)
      md.push(`- #${e.number} ${cell(e.title)} — ${badge(e.state)} ${time(e.updated_at)}`);
    md.push('');
  }
  if (state.history.length) {
    md.push('<details><summary>Recent activity</summary>', '');
    for (const h of state.history)
      md.push(
        `- ${time(h.at)} — ${h.op}${h.pr ? ` #${h.pr}` : ''} by @${h.by}${h.detail ? `: ${cell(h.detail)}` : ''}`,
      );
    md.push('', '</details>', '');
  }
  md.push('## Available commands', '');
  md.push(
    'On a PR: `/queue add` · `/queue remove` · `/queue hold` · `/queue resume` · `/queue retry` · `/queue status`',
    '',
  );
  md.push(
    'On this issue: `/queue status` · `/queue build [rc-id]` · `/queue freeze` · `/queue unfreeze` · `/queue move #PR POS` · `/queue hold #PR` (and the other PR commands with `#PR`)',
    '',
  );
  md.push(serializeState(state));
  return md.join('\n') + '\n';
}

export function renderPrComment(state, entry, meta = {}) {
  const cc = state.current_candidate;
  const inCandidate = cc?.prs.includes(entry.number);
  const md = [STICKY_MARKER, '## Release Queue Status', ''];
  md.push(
    `**State:** ${badge(entry.state)}${entry.state_reason ? ` (${entry.state_reason})` : ''}`,
    '',
  );
  const pos = positionOf(state, entry.number);
  if (pos) md.push(`**Queue position:** ${pos} of ${activeEntries(state).length}`, '');
  md.push(`**Head SHA:** ${short(entry.head_sha)}${revision(entry)}`, '');
  md.push(
    `**Queue:** ${
      activeEntries(state)
        .map((e) => (e.number === entry.number ? `**#${e.number}**` : `#${e.number}`))
        .join(' → ') || '(empty)'
    }`,
    '',
  );
  if (entry.last_candidate)
    md.push(
      `**Candidate:** ${entry.last_candidate}${inCandidate && cc.id === entry.last_candidate ? ` (${cc.status})` : ''}`,
      '',
    );

  switch (entry.state) {
    case 'VALIDATING':
      md.push(
        `Candidate **${cc.id}** is currently validating.`,
        '',
        `Candidate queue: ${queueLine(cc.prs.map((number) => ({ number })))}`,
        '',
      );
      break;
    case 'VALIDATED':
      if (inCandidate) md.push('**Combined validation:**', '', ...validationLines(cc), '');
      if (cc?.status === 'VALIDATED' && inCandidate)
        md.push(
          `Candidate SHA ${short(cc.candidate_sha)} · tree ${short(cc.candidate_tree_sha)}`,
          '',
        );
      break;
    case 'TEST_FAILED':
    case 'MERGE_CONFLICT':
    case 'BLOCKED':
      if (inCandidate && cc.first_failing_pr === entry.number) {
        md.push(
          `**First failing addition:** #${entry.number} in ${cc.id}`,
          '',
          `**Passed prefix:** ${refs(cc.passed_prs) || 'none'}`,
          '',
        );
        md.push('**Combined validation:**', '', ...validationLines(cc), '');
        md.push(
          `PR #${entry.number} is the first addition after which the candidate failed; the cause may be this PR or an interaction with earlier PRs.`,
          '',
        );
      }
      md.push(...detailLines(entry.result_detail, entry.number), '');
      md.push(
        '**Suggested action:** fix this PR (or coordinate with the related PR authors), push the fix, then `/queue retry`. Or `/queue hold` / `/queue remove` to take it out of the next candidate.',
        '',
      );
      break;
    case 'STALE_PR':
      md.push(
        'This PR changed while its candidate was validating, so the result was not accepted. Use `/queue retry` to queue the new revision.',
        '',
      );
      break;
    case 'STALE_MAIN':
      md.push(
        '`main` changed while the candidate was validating. The PR stays queued; the next `/queue build` uses the latest main.',
        '',
      );
      break;
    case 'HELD':
      md.push(
        'Held: excluded from candidates. `/queue resume` puts it back at the end of the active queue.',
        '',
      );
      break;
    case 'READY':
      md.push('The queue is frozen. This PR will be queued when the queue is unfrozen.', '');
      break;
    case 'REMOVED':
    case 'MERGED':
      md.push(
        `No longer in the release queue${entry.state_reason ? `: ${entry.state_reason}` : ''}. \`/queue add\` to rejoin.`,
        '',
      );
      break;
    default:
      md.push(
        entry.last_result
          ? `**Last result:** ${entry.last_result}`
          : '**Last validation:** waiting for the next candidate',
        '',
      );
  }
  const commands =
    {
      QUEUED: '/queue status · /queue hold · /queue remove',
      VALIDATING: '/queue status · /queue hold · /queue remove',
      VALIDATED: '/queue status · /queue hold · /queue remove',
      HELD: '/queue resume · /queue remove · /queue status',
      READY: '/queue status · /queue remove',
      REMOVED: '/queue add',
      MERGED: '/queue status',
    }[entry.state] ?? '/queue retry · /queue hold · /queue remove · /queue status';
  md.push(
    `**Commands:** ${commands
      .split(' · ')
      .map((c) => `\`${c}\``)
      .join(' · ')}`,
    '',
  );
  md.push(
    `<sub>Updated ${time(meta.now ?? new Date().toISOString())}${meta.dashboardUrl ? ` · [Queue dashboard](${meta.dashboardUrl})` : ''}</sub>`,
  );
  return md.join('\n') + '\n';
}

export function renderStatus(state, entry) {
  const lines = [];
  if (entry) {
    lines.push(`**PR #${entry.number}** — ${badge(entry.state)}`, '');
    const pos = positionOf(state, entry.number);
    lines.push(
      `- Position: ${pos ?? 'not in the active queue'}`,
      `- Head SHA: ${short(entry.head_sha)}${revision(entry)}`,
    );
    lines.push(
      `- Last candidate: ${entry.last_candidate ?? 'none'} · last result: ${entry.last_result ?? 'none'}`,
    );
  }
  const cc = state.current_candidate;
  lines.push(`- Current candidate: ${cc ? `${cc.id} (${cc.status})` : 'none'}`);
  lines.push(`- Active queue: ${queueLine(activeEntries(state))}`);
  const held = state.entries.filter((e) => e.state === 'HELD');
  lines.push(`- Held: ${held.length ? refs(held.map((e) => e.number)) : 'none'}`);
  lines.push(`- Queue frozen: ${state.frozen ? 'Yes' : 'No'}`);
  return lines.join('\n');
}

export function renderOperationSummary(state, op) {
  const held = state.entries.filter((e) => e.state === 'HELD');
  return [
    '# Queue Operation',
    `**Operation:** ${op.name.toUpperCase()}${op.outcome ? ` — ${op.outcome}` : ''}`,
    op.pr ? `**PR:** #${op.pr}` : null,
    `**Performed by:** @${op.by}`,
    op.prev ? `**Previous state:** ${op.prev}` : null,
    op.next ? `**New state:** ${op.next}` : null,
    op.message ? `\n${op.message}\n` : null,
    `**Current active queue:** ${queueLine(activeEntries(state))}`,
    `**Held:** ${held.length ? refs(held.map((e) => e.number)) : 'none'}`,
    `**Queue frozen:** ${state.frozen ? 'Yes' : 'No'}`,
  ]
    .filter((l) => l !== null)
    .join('\n\n');
}

export function renderResultSummary(state) {
  const cc = state.current_candidate;
  const failIndex = cc.first_failing_pr ? cc.prs.indexOf(cc.first_failing_pr) : -1;
  const icon = (i) =>
    cc.status === 'VALIDATED' || (failIndex >= 0 && i < failIndex)
      ? '✅'
      : i === failIndex
        ? '❌'
        : '⏸️';
  return [
    '# Candidate Result',
    `**Candidate:** ${cc.id}`,
    `**Result:** ${cc.status}`,
    '**Queue:**',
    cc.prs.map((n, i) => `- #${n} ${icon(i)}`).join('\n'),
    cc.note ? `**Note:** ${cc.note}` : null,
    `**Active queue now:** ${queueLine(activeEntries(state))}`,
  ]
    .filter((l) => l !== null)
    .join('\n\n');
}
