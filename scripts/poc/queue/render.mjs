// Markdown for the queue dashboard issue, PR sticky comments and job summaries.
import {
  EJECTED,
  INACTIVE,
  positionOf,
  queueEntries,
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
  SUPERSEDED: '⏭️ SUPERSEDED',
  CANCELLED: '⏹️ CANCELLED',
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

/** "alice (#1, #3), bob (#2)": one entry per person. */
function collaboratorList(collaborators, mention) {
  const byAuthor = new Map();
  for (const c of collaborators)
    byAuthor.set(c.author, [...(byAuthor.get(c.author) ?? []), c.number]);
  return [...byAuthor]
    .map(
      ([author, prs]) => `${mention ? '@' : ''}${author} (${prs.map((n) => `#${n}`).join(', ')})`,
    )
    .join(', ');
}

/** Bullet lines describing a TEST_FAILED / MERGE_CONFLICT detail. */
function detailLines(detail, failing, { mention = true } = {}) {
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
    lines.push(`- Suggested collaborators: ${collaboratorList(detail.collaborators, mention)}`);
  }
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

// ---- Dashboard: plain words first, details folded away ----
const STATUS_WORDS = {
  QUEUED: '⏳ Waiting for check',
  VALIDATING: '🔄 Being checked',
  VALIDATED: '✅ Ready',
};
/** Dashboard text must not @-mention people: it is rewritten on every queue change. */
const noPing = (text) => cell(text).replaceAll('@', '');
const list = (numbers) => numbers.map((n) => `#${n}`).join(', ');
const peersOf = (e) => {
  const d = e.result_detail;
  const others = d?.type === 'MERGE_CONFLICT' ? d.direct_conflicts_with : d?.related_prs;
  return (others ?? []).filter((n) => n !== e.number);
};

/** What went wrong, in one short sentence. */
function problem(e) {
  const peers = peersOf(e);
  const withPeers = peers.length ? ` with ${list(peers)}` : '';
  switch (e.state) {
    case 'TEST_FAILED':
      return `Tests fail${peers.length ? ` when combined with ${list(peers)}` : ''}`;
    case 'MERGE_CONFLICT': {
      const files = e.result_detail?.conflicting_files ?? [];
      return `Merge conflict${withPeers}${files.length ? ` in ${files.map((f) => `\`${f.split('/').pop()}\``).join(', ')}` : ''}`;
    }
    case 'STALE_PR':
      return 'New commits were pushed';
    default:
      return cell(e.state_reason ?? 'Needs attention');
  }
}
const NEXT_STEP = {
  TEST_FAILED: 'Fix it, push, then comment `/queue retry`',
  MERGE_CONFLICT: 'Resolve the conflict, push, then comment `/queue retry`',
  STALE_PR: 'Comment `/queue retry` to check the new commits',
  BLOCKED: 'Fix it, then comment `/queue retry`',
};

function headline(state, queued, ejected) {
  const prs = list(queued.map((e) => e.number));
  let line;
  if (!queued.length) {
    line = 'The queue is empty. Comment `/queue add` on a pull request to join.';
  } else if (queued.some((e) => e.state === 'VALIDATING')) {
    line = `🔄 **Checking ${prs} together…**`;
  } else if (queued.every((e) => e.state === 'VALIDATED')) {
    line = `✅ **${prs} ${queued.length > 1 ? 'pass together and are' : 'passes and is'} ready to release.**`;
  } else {
    line = `⏳ **The queue changed.** A new check of ${prs} starts in a moment.`;
  }
  if (ejected.length) {
    line += ` ${ejected.length} PR${ejected.length > 1 ? 's need' : ' needs'} attention below.`;
  }
  return line;
}

const details = (title, lines) => [
  '<details>',
  `<summary>${title}</summary>`,
  '',
  ...lines,
  '',
  '</details>',
  '',
];

export function renderDashboard(state, meta = {}) {
  const queued = queueEntries(state);
  const ejected = state.entries.filter((e) => EJECTED.has(e.state));
  const held = state.entries.filter((e) => e.state === 'HELD');
  const ready = state.entries.filter((e) => e.state === 'READY');
  const inactive = state.entries
    .filter((e) => INACTIVE.has(e.state))
    .slice(-10)
    .reverse();
  const cc = state.current_candidate;

  const md = [`# 🚦 ${QUEUE_TITLE}`, ''];
  if (state.frozen) {
    md.push(`> 🧊 **The queue is frozen**: no PR can join until \`/queue unfreeze\`.`, '');
  }
  md.push(headline(state, queued, ejected), '');
  md.push(
    `<sub>Updated ${time(meta.now ?? new Date().toISOString())}${cc?.run_url ? ` · [latest check (${cc.id})](${cc.run_url})` : ''} · the queue re-checks itself whenever it or \`main\` changes</sub>`,
    '',
  );

  md.push('## Queue', '');
  if (queued.length) {
    md.push('| # | Pull request | Status |', '|---|---|---|');
    queued.forEach((e, i) =>
      md.push(
        `| ${i + 1} | #${e.number} | ${STATUS_WORDS[e.state]}${e.new_revision ? ' · 🆕 new commits' : ''} |`,
      ),
    );
  } else {
    md.push('_Empty._');
  }
  md.push('');

  if (ejected.length) {
    md.push(
      '## ❌ Needs attention',
      '',
      '_These PRs were taken out of the queue so the others can still ship._',
      '',
    );
    md.push('| Pull request | Problem | What to do |', '|---|---|---|');
    for (const e of ejected)
      md.push(`| #${e.number} | ${problem(e)} | ${NEXT_STEP[e.state] ?? NEXT_STEP.BLOCKED} |`);
    md.push('');
    for (const e of ejected) {
      if (!e.result_detail && !e.failure) continue;
      const f = e.failure;
      md.push(
        ...details(`Why #${e.number} was taken out`, [
          ...(f
            ? [
                `Checked in ${f.candidate}: ${list(f.passed_prs) || 'nothing'} passed, then adding #${e.number} failed (${f.status}).`,
                '',
              ]
            : []),
          ...detailLines(e.result_detail, e.number, { mention: false }),
          '',
          'This is a hint, not a verdict: the cause may be this PR or how it combines with the others.',
        ]),
      );
    }
  }

  if (held.length) {
    md.push(
      '## ⏸️ On hold',
      '',
      `${list(held.map((e) => e.number))} — not included in checks. \`/queue resume\` brings a PR back.`,
      '',
    );
  }
  if (ready.length) {
    md.push(
      '## ⏳ Waiting for unfreeze',
      '',
      `${list(ready.map((e) => e.number))} will join when the queue is unfrozen.`,
      '',
    );
  }

  const technical = [];
  if (cc) {
    technical.push(
      `- Latest check: **${cc.id}** — ${badge(cc.status)} · ${queueLine(cc.prs.map((number) => ({ number })))} · started ${time(cc.started_at)}${cc.finished_at ? `, finished ${time(cc.finished_at)}` : ''}${cc.reason ? ` · reason: ${noPing(cc.reason)}` : ''}`,
    );
    if (cc.status === 'VALIDATED') {
      technical.push(
        `- Candidate SHA ${short(cc.candidate_sha)} · tree ${short(cc.candidate_tree_sha)} · base main ${short(cc.base_main_sha)}`,
      );
    }
    if (cc.note) technical.push(`- Note: ${cell(cc.note)}`);
  }
  technical.push(`- Queue revision ${state.revision}`);
  for (const e of [...queued, ...ejected, ...held, ...ready]) {
    technical.push(
      `- #${e.number}: ${e.author} · head ${short(e.head_sha)}${revision(e)} · ${badge(e.state)}${e.last_result ? ` · last result ${cell(e.last_result)}${e.last_candidate ? ` (${e.last_candidate})` : ''}` : ''}`,
    );
  }
  md.push(...details('Technical details', technical));
  if (inactive.length) {
    md.push(
      ...details(
        'Recently removed or merged',
        inactive.map((e) => `- #${e.number} — ${badge(e.state)} ${time(e.updated_at)}`),
      ),
    );
  }
  if (state.history.length) {
    md.push(
      ...details(
        'Recent activity',
        state.history.map(
          (h) =>
            `- ${time(h.at)} — ${h.op}${h.pr ? ` #${h.pr}` : ''} by ${h.by}${h.detail ? `: ${noPing(h.detail)}` : ''}`,
        ),
      ),
    );
  }
  md.push(
    ...details('Commands', [
      '**On a pull request:** `/queue add` join · `/queue remove` leave · `/queue hold` pause · `/queue resume` un-pause · `/queue retry` re-check after a fix · `/queue status`',
      '',
      '**On this issue:** `/queue status` · `/queue revalidate` re-check now · `/queue freeze` / `/queue unfreeze` · `/queue move #PR POS` · any PR command with `#PR`, e.g. `/queue hold #3`',
    ]),
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
  if (pos) md.push(`**Queue position:** ${pos} of ${queueEntries(state).length}`, '');
  md.push(`**Head SHA:** ${short(entry.head_sha)}${revision(entry)}`, '');
  md.push(
    `**Queue:** ${
      queueEntries(state)
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
    case 'QUEUED':
      md.push(
        'Waiting for the next candidate: the queue changed, so it is revalidated automatically in a moment.',
        '',
      );
      break;
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
      if (entry.failure) {
        const f = entry.failure;
        md.push(
          `**First failing addition:** #${entry.number} in ${f.candidate}`,
          '',
          `**Passed prefix:** ${refs(f.passed_prs) || 'none'}`,
          '',
        );
        md.push('**Combined validation:**', '', ...validationLines(f), '');
        md.push(
          `PR #${entry.number} is the first addition after which the candidate failed; the cause may be this PR or an interaction with earlier PRs.`,
          '',
        );
      }
      md.push(...detailLines(entry.result_detail, entry.number), '');
      md.push(
        '**Ejected from the queue.** The rest of the queue is validated without this PR.',
        '',
        '**Suggested action:** fix this PR (or coordinate with the related PR authors) and push the fix, then `/queue retry` to return to your previous place or `/queue add` to rejoin at the end.',
        '',
      );
      break;
    case 'STALE_PR':
      md.push(
        '**New commits were pushed, so this PR left the queue** (its validation no longer matches the code). The rest of the queue is revalidated without it.',
        '',
        '`/queue retry` returns it to its previous place with the new revision; `/queue add` rejoins at the end.',
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
    }[entry.state] ?? '/queue retry · /queue add · /queue remove · /queue status';
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
      `- Position: ${pos ?? 'not in the queue'}`,
      `- Head SHA: ${short(entry.head_sha)}${revision(entry)}`,
    );
    lines.push(
      `- Last candidate: ${entry.last_candidate ?? 'none'} · last result: ${entry.last_result ?? 'none'}`,
    );
  }
  const cc = state.current_candidate;
  lines.push(`- Current candidate: ${cc ? `${cc.id} (${cc.status})` : 'none'}`);
  lines.push(`- Queue: ${queueLine(queueEntries(state))}`);
  const held = state.entries.filter((e) => e.state === 'HELD');
  const ejected = state.entries.filter((e) => EJECTED.has(e.state));
  lines.push(
    `- Ejected: ${ejected.length ? ejected.map((e) => `#${e.number} (${e.state})`).join(', ') : 'none'}`,
  );
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
    `**Queue:** ${queueLine(queueEntries(state))}`,
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
    `**Queue now:** ${queueLine(queueEntries(state))}`,
  ]
    .filter((l) => l !== null)
    .join('\n\n');
}
