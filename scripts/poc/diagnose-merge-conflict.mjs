#!/usr/bin/env node
// Turns a MERGE_CONFLICT candidate into a diagnosis: the conflicted files, which earlier selected
// PRs touched them, and pairwise checks (base main + earlier PR + failing PR) showing which PR
// reproduces the conflict on its own. Pairwise merges run in memory with `git merge-tree`: nothing
// is checked out, no branch is created and nothing is pushed. It reports only; it never resolves
// conflicts or changes code, and never claims one PR is at fault.
// Reads (from $RUNNER_TEMP/poc-state): failure.json, prs.json. Env: BASE_MAIN_SHA, CANDIDATE_ID
// Writes: candidate-merge-diagnosis.json, diagnosis.md
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const state = path.join(process.env.RUNNER_TEMP, 'poc-state');
const readJson = (name) => JSON.parse(readFileSync(path.join(state, name), 'utf8'));

if (!existsSync(path.join(state, 'failure.json'))) process.exit(0);
const failure = readJson('failure.json');
if (failure.failure_type !== 'MERGE_CONFLICT') {
  console.log(`Failure type is ${failure.failure_type}; merge-conflict diagnosis not needed.`);
  process.exit(0);
}

const base = process.env.BASE_MAIN_SHA;
const prs = readJson('prs.json');
const failingPr = prs.find((p) => p.number === failure.failed_pr);
const earlierPrs = failure.passed_prs.map((n) => prs.find((p) => p.number === n));
const conflictingFiles = failure.conflicting_files;

// ---- Which earlier PRs changed the conflicted files ----
const related = earlierPrs
  .map((p) => ({ pr: p, shared: conflictingFiles.filter((f) => (p.files ?? []).includes(f)) }))
  .filter((r) => r.shared.length > 0);

// ---- Pairwise checks from the captured base, using the captured PR head SHAs ----
const identity = {
  GIT_AUTHOR_NAME: 'Candidate Builder',
  GIT_AUTHOR_EMAIL: 'candidate-builder@users.noreply.github.com',
  GIT_COMMITTER_NAME: 'Candidate Builder',
  GIT_COMMITTER_EMAIL: 'candidate-builder@users.noreply.github.com',
};
const git = (args) => {
  const r = spawnSync('git', args, { encoding: 'utf8', env: { ...process.env, ...identity } });
  if (r.status === null || r.status > 1) throw new Error(`git ${args[0]} failed: ${r.stderr}`);
  return r;
};
// Merges `theirs` into `ours` in memory. Exit status 1 means conflicts.
const mergeTree = (ours, theirs) => {
  const r = git(['merge-tree', '--write-tree', '--name-only', '--no-messages', ours, theirs]);
  const [tree, ...files] = r.stdout.split('\n').filter(Boolean);
  return { clean: r.status === 0, tree, conflicts: [...new Set(files)] };
};

const MAX_PAIRWISE = 20;
const pairwise = earlierPrs.slice(0, MAX_PAIRWISE).map((p) => {
  const label = `base main + #${p.number} + #${failingPr.number}`;
  const first = mergeTree(base, p.head_sha);
  if (!first.clean) {
    return {
      number: p.number,
      label,
      result: 'NOT_TESTED',
      conflicts: [],
      note: `#${p.number} does not merge onto base main by itself`,
    };
  }
  const commit = git([
    'commit-tree',
    first.tree,
    '-p',
    base,
    '-p',
    p.head_sha,
    '-m',
    'pairwise diagnosis',
  ]).stdout.trim();
  const second = mergeTree(commit, failingPr.head_sha);
  return {
    number: p.number,
    label,
    result: second.clean ? 'PASS' : 'MERGE_CONFLICT',
    conflicts: second.conflicts,
  };
});
const pairwiseFor = (n) => pairwise.find((r) => r.number === n);
const direct = pairwise
  .filter((r) => r.result === 'MERGE_CONFLICT')
  .map((r) => prs.find((p) => p.number === r.number));

// ---- Interpretation (cautious wording only) ----
const list = (items) =>
  items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
const refs = (ps) => list(ps.map((p) => `#${p.number}`));
const interpretation = [];
if (earlierPrs.length === 0) {
  interpretation.push(
    `PR #${failingPr.number} could not be merged onto base main itself; no earlier selected PR is involved.`,
  );
} else if (direct.length === 1) {
  interpretation.push(
    `PR #${failingPr.number} directly conflicts with PR #${direct[0].number} in the tested pairwise combination.`,
  );
} else if (direct.length > 1) {
  interpretation.push(`PR #${failingPr.number} has direct merge conflicts with ${refs(direct)}.`);
} else if (pairwise.some((r) => r.result === 'PASS')) {
  interpretation.push(
    'The conflict appears only in the multi-PR cumulative state.',
    'No single earlier PR reproduced the conflict independently.',
  );
}
for (const r of pairwise) {
  if (r.result === 'PASS' && related.some((x) => x.pr.number === r.number)) {
    interpretation.push(`PR #${r.number} did not independently reproduce the conflict.`);
  }
  if (r.result === 'NOT_TESTED')
    interpretation.push(`Pairwise check with #${r.number} was not possible: ${r.note}.`);
}
if (earlierPrs.length > MAX_PAIRWISE)
  interpretation.push(`Only the first ${MAX_PAIRWISE} earlier PRs were checked pairwise.`);
if (earlierPrs.length > 0) {
  interpretation.push(
    'This does not necessarily mean either PR is incorrect. Git cannot automatically combine their changes to the same code area.',
  );
}

// Coordinate with PRs that reproduce the conflict; fall back to file-overlap evidence.
const partners = direct.length > 0 ? direct : related.map((r) => r.pr);
const collaborators = [failingPr, ...partners];

// ---- JSON artifact ----
const diagnosis = {
  candidate_id: process.env.CANDIDATE_ID,
  failure_type: 'MERGE_CONFLICT',
  base_main_sha: base,
  first_failing_pr: failingPr.number,
  passed_prs: failure.passed_prs,
  failed_combination: [...failure.passed_prs, failingPr.number],
  conflicting_files: conflictingFiles,
  related_prs: related.map((r) => ({
    number: r.pr.number,
    title: r.pr.title,
    author: r.pr.author,
    head_sha: r.pr.head_sha,
    shared_files: r.shared,
    pairwise_result: pairwiseFor(r.pr.number)?.result ?? 'NOT_TESTED',
  })),
  pairwise: pairwise.map(({ number, label, result, conflicts, note }) => ({
    earlier_pr: number,
    failing_pr: failingPr.number,
    combination: label,
    result,
    conflicting_files: conflicts,
    note,
  })),
  direct_conflicts_with: direct.map((p) => p.number),
  interpretation,
  suggested_collaborators: collaborators.map((p) => ({
    number: p.number,
    title: p.title,
    author: p.author,
  })),
  prs: prs.map((p) => ({
    number: p.number,
    title: p.title,
    author: p.author,
    head_sha: p.head_sha,
    changed_files: p.files ?? [],
  })),
};
writeFileSync(
  path.join(state, 'candidate-merge-diagnosis.json'),
  JSON.stringify(diagnosis, null, 2),
);

// ---- Markdown for the job summary ----
const code = (f) => `\`${f}\``;
const md = ['### Conflicting files', '', ...conflictingFiles.map((f) => `- ${code(f)}`), ''];

md.push('### Conflict analysis', '');
if (related.length > 0) {
  const overlap = [...new Set(related.flatMap((r) => r.shared))];
  md.push(
    `PR #${failingPr.number} could not be merged because its changes overlap with changes already present in the candidate, in:`,
    '',
  );
  md.push(...overlap.map((f) => `- ${code(f)}`), '', '**Potentially related PRs:**', '');
  for (const r of related) {
    md.push(
      `**#${r.pr.number} ${r.pr.title}** — @${r.pr.author}`,
      '',
      `Shared conflicted files with #${failingPr.number}:`,
    );
    md.push(...r.shared.map((f) => `- ${code(f)}`), '');
  }
} else {
  md.push(
    'No earlier selected PR could be directly associated with the conflicted file using changed-file overlap.',
    '',
  );
}

if (pairwise.length > 0) {
  md.push(
    '### Pairwise analysis',
    '',
    `Each check starts from base main \`${base.slice(0, 12)}\` and uses the selected PR head SHAs.`,
    '',
  );
  md.push('| Combination | Result | Conflicting files |', '|---|---|---|');
  for (const r of pairwise) {
    md.push(
      `| ${r.label} | ${r.result === 'PASS' ? '✅' : r.result === 'MERGE_CONFLICT' ? '❌' : '⏸️'} ${r.result} | ${r.conflicts.map(code).join(', ') || '—'} |`,
    );
  }
  md.push(
    `| ${['base main', ...diagnosis.failed_combination.map((n) => `#${n}`)].join(' + ')} (full candidate) | ❌ MERGE_CONFLICT | ${conflictingFiles.map(code).join(', ')} |`,
    '',
  );
}

md.push('### Interpretation', '', ...interpretation.map((l) => `- ${l}`), '');

md.push('### Suggested collaborators', '');
md.push(...collaborators.map((p) => `- Author of PR #${p.number}: @${p.author}`), '');

md.push('### Suggested resolution', '');
if (partners.length > 0) {
  const others = refs(partners);
  md.push(`**If ${others} ${partners.length > 1 ? 'are' : 'is'} released first:**`, '');
  md.push(`1. Merge/release ${others} through the normal process.`);
  md.push(`2. Update PR #${failingPr.number} from the latest main.`);
  md.push(
    `3. Resolve the conflicting file${conflictingFiles.length > 1 ? 's' : ''}, preserving both intended behaviors.`,
  );
  md.push(`4. Push the resolution to PR #${failingPr.number} and re-run its CI.`);
  md.push(`5. Re-add PR #${failingPr.number} to a release candidate.`, '');
  md.push('**If they must ship in the same release:**', '');
  md.push(
    `1. The authors of ${refs([failingPr, ...partners])} should coordinate on the conflicting implementation.`,
  );
  md.push('2. Resolve the conflict on the appropriate feature branch.');
  md.push('3. Re-run individual PR CI.');
  md.push('4. Rebuild the candidate.');
} else {
  md.push(
    `1. Update PR #${failingPr.number} from the latest main (or from a branch containing ${refs(earlierPrs) || 'the earlier PRs'}).`,
  );
  md.push('2. Resolve the conflicting files and push the resolution.');
  md.push('3. Re-run the PR CI, then rebuild the candidate.');
}
writeFileSync(path.join(state, 'diagnosis.md'), md.join('\n') + '\n');

if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, 'diagnosed=true\n');
console.log(md.join('\n'));
