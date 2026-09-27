#!/usr/bin/env node
// Turns a TEST_FAILED candidate into a diagnosis: which tests failed, which selected PRs
// touched the failing code, and heuristic hints. It only reports, never changes code, and
// never claims a root cause.
// Reads (from $RUNNER_TEMP/poc-state): failure.json, prs.json, vitest-report.json
// Writes: candidate-test-diagnosis.json, diagnosis.md
import { appendFileSync, existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const state = path.join(process.env.RUNNER_TEMP, 'poc-state');
const readJson = (name) => JSON.parse(readFileSync(path.join(state, name), 'utf8'));

if (!existsSync(path.join(state, 'failure.json'))) process.exit(0);
const failure = readJson('failure.json');
if (failure.failure_type !== 'TEST_FAILED') {
  console.log(`Failure type is ${failure.failure_type}; test diagnosis not needed.`);
  process.exit(0);
}

const prs = readJson('prs.json');
const failingPr = prs.find((p) => p.number === failure.failed_pr);
const earlierPrs = prs.filter((p) => failure.passed_prs.includes(p.number));

// ---- Failed tests from the machine-readable Vitest report ----
const roots = [...new Set([process.cwd(), realpathSync(process.cwd())])];
const toRepoPath = (p) => {
  for (const root of roots) if (p.startsWith(root + path.sep)) return p.slice(root.length + 1);
  return null; // outside the repo
};
// Stack traces are stored with repo-relative paths so they stay readable.
const relativize = (text) =>
  roots.reduce((t, root) => t.replaceAll(root + path.sep, ''), text ?? '');
const srcFrames = (text) =>
  [...(text ?? '').matchAll(/(\/[^\s():]+):\d+:\d+/g)]
    .map((m) => toRepoPath(m[1]))
    .filter((p) => p && !p.startsWith('node_modules/'));

const reportPath = path.join(state, 'vitest-report.json');
const report = existsSync(reportPath) ? JSON.parse(readFileSync(reportPath, 'utf8')) : null;
const failedTests = [];
for (const suite of report?.testResults ?? []) {
  const file = toRepoPath(suite.name) ?? suite.name;
  const failed = (suite.assertionResults ?? []).filter((a) => a.status === 'failed');
  for (const a of failed) {
    const text = (a.failureMessages ?? []).join('\n');
    failedTests.push({
      file,
      name: a.fullName,
      message: text.split('\n')[0] || '(no message)',
      stack: relativize(text).slice(0, 4000),
      frames: srcFrames(text),
    });
  }
  if (suite.status === 'failed' && failed.length === 0) {
    // The file failed as a whole (e.g. an import or syntax error).
    failedTests.push({
      file,
      name: '(test file failed to run)',
      message: (suite.message ?? '').split('\n')[0] || '(no message)',
      stack: relativize(suite.message).slice(0, 4000),
      frames: srcFrames(suite.message),
    });
  }
}

// ---- Correlate failure paths with each PR's changed files ----
const failedFiles = new Set(failedTests.map((t) => t.file));
const throwSites = new Set(failedTests.map((t) => t.frames[0]).filter(Boolean));
const callPath = new Set(failedTests.flatMap((t) => t.frames.slice(1)));

const evidenceFor = (pr) => {
  const files = new Set(pr.files ?? []);
  const strong = [];
  const weak = [];
  for (const f of failedFiles)
    if (files.has(f)) strong.push(`changed the failing test file \`${f}\``);
  for (const f of throwSites)
    if (files.has(f)) strong.push(`changed \`${f}\`, where the error was thrown`);
  for (const f of callPath) {
    if (files.has(f) && !throwSites.has(f))
      weak.push(`changed \`${f}\`, which is on the failing call path`);
  }
  return { strong, weak };
};

const evidence = Object.fromEntries(prs.map((p) => [p.number, evidenceFor(p)]));
const relatedEarlier = earlierPrs.filter((p) => evidence[p.number].strong.length > 0);
const weakEarlier = earlierPrs.filter(
  (p) => evidence[p.number].strong.length === 0 && evidence[p.number].weak.length > 0,
);
const interactionFound = relatedEarlier.length > 0;
const relatedPrs = [...relatedEarlier, failingPr];

// ---- Heuristic hints (never certain) ----
const MODEL_FILE =
  /(^|\/)(types?|models?|interfaces?|schemas?|contracts?)(\/|\.[jt]sx?$)|\.d\.ts$/i;
const TYPE_ERROR = /TypeError|is not a function|undefined|cannot read|property/i;
const ASSERTION =
  /AssertionError|expected .+ to |Unable to find|toMatch(Inline)?Snapshot|Snapshot .+ mismatched/i;
const messages = failedTests.map((t) => t.stack).join('\n');
// Compare the failing PR with evidence-backed PRs, or with every earlier PR if there are none.
const peers = interactionFound ? relatedEarlier : earlierPrs;
const hints = [];

const modelChanges = [failingPr, ...peers]
  .map((p) => ({ pr: p.number, files: (p.files ?? []).filter((f) => MODEL_FILE.test(f)) }))
  .filter((m) => m.files.length > 0);
if (TYPE_ERROR.test(messages) && modelChanges.length > 0) {
  hints.push({
    category: 'DATA_MODEL_OR_CONTRACT_CHANGE',
    detail: modelChanges.map((m) => `#${m.pr} changes type/model files: ${m.files.join(', ')}`),
  });
}
if (ASSERTION.test(messages)) {
  hints.push({
    category: 'BEHAVIOR_OR_UI_CHANGE',
    detail: ['Failures are assertion mismatches, not crashes'],
  });
}
const failingFiles = new Set(failingPr.files ?? []);
const sharedFiles = peers.flatMap((p) =>
  (p.files ?? [])
    .filter((f) => failingFiles.has(f))
    .map((f) => `#${p.number} and #${failingPr.number} both change ${f}`),
);
if (sharedFiles.length > 0) hints.push({ category: 'SHARED_FILE_CHANGE', detail: sharedFiles });
const failingDirs = new Set([...failingFiles].map((f) => path.dirname(f)));
const sharedDirs = peers.flatMap((p) => {
  const dirs = [...new Set((p.files ?? []).map((f) => path.dirname(f)))].filter((d) =>
    failingDirs.has(d),
  );
  return dirs.length
    ? [`#${p.number} and #${failingPr.number} both change files in ${dirs.join(', ')}`]
    : [];
});
if (sharedDirs.length > 0) hints.push({ category: 'SHARED_MODULE_CHANGE', detail: sharedDirs });
if (hints.length === 0) hints.push({ category: 'UNKNOWN', detail: ['No heuristic matched'] });

const collaborators = [...new Set(relatedPrs.map((p) => p.author))];

// ---- JSON artifact ----
const diagnosis = {
  candidate_id: process.env.CANDIDATE_ID,
  failure_type: 'TEST_FAILED',
  first_failing_pr: failingPr.number,
  passed_prs: failure.passed_prs,
  failed_combination: [...failure.passed_prs, failingPr.number],
  test_report_found: report !== null,
  failed_tests: failedTests.map(({ frames, ...t }) => ({ ...t, source_frames: frames })),
  related_prs: interactionFound ? relatedPrs.map((p) => p.number) : [failingPr.number],
  interaction_identified: interactionFound,
  weaker_signal_prs: weakEarlier.map((p) => p.number),
  interaction_category: hints[0].category,
  hints,
  evidence: prs.map((p) => ({
    number: p.number,
    title: p.title,
    author: p.author,
    head_sha: p.head_sha,
    changed_files: p.files ?? [],
    strong_evidence: evidence[p.number].strong,
    weak_evidence: evidence[p.number].weak,
  })),
  suggested_collaborators: collaborators,
};
writeFileSync(
  path.join(state, 'candidate-test-diagnosis.json'),
  JSON.stringify(diagnosis, null, 2),
);

// ---- Markdown for the job summary ----
const fence = (s) => '~~~\n' + s.replaceAll('~~~', '~ ~ ~') + '\n~~~';
const prLabel = (p) => `#${p.number} ${p.title} (@${p.author})`;
const md = [];
md.push('### Failed tests', '');
if (!report) {
  md.push(
    'No machine-readable test report was produced (the test run may have crashed before reporting). See the TEST step log.',
    '',
  );
}
const byFile = Map.groupBy(failedTests, (t) => t.file);
for (const [file, tests] of byFile) {
  md.push(`**File:** \`${file}\``, '', '**Tests:**');
  for (const t of tests.slice(0, 20)) md.push(`- ${t.name}`);
  if (tests.length > 20) md.push(`- …and ${tests.length - 20} more`);
  md.push(
    '',
    '**Error:**',
    fence([...new Set(tests.map((t) => t.message))].slice(0, 3).join('\n')),
    '',
  );
}
const firstStack = failedTests.find((t) => t.stack)?.stack;
if (firstStack) {
  md.push(
    '<details><summary>First stack trace</summary>',
    '',
    fence(firstStack.split('\n').slice(0, 15).join('\n')),
    '',
    '</details>',
    '',
  );
}

md.push('### Potential interaction', '');
if (interactionFound) {
  md.push('**Likely related PRs:**');
  for (const p of relatedPrs) md.push(`- ${prLabel(p)}`);
} else {
  md.push('No clear PR interaction could be identified automatically.');
}
md.push(
  '',
  `**Potential category:** ${hints[0].category}${
    hints.length > 1
      ? ` (also: ${hints
          .slice(1)
          .map((h) => h.category)
          .join(', ')})`
      : ''
  }`,
  '',
);
md.push('**Reasoning** (hints only, not a confirmed root cause):');
md.push(`- #${failingPr.number} is the first addition after which the combined candidate failed.`);
for (const p of relatedPrs)
  for (const e of evidence[p.number].strong) md.push(`- #${p.number} ${e}`);
for (const h of hints) for (const d of h.detail) md.push(`- ${h.category}: ${d}`);
for (const p of weakEarlier)
  for (const e of evidence[p.number].weak) md.push(`- Weaker signal: #${p.number} ${e}`);
md.push('');
md.push('### Suggested next action', '');
md.push(`**Suggested collaborators:** ${collaborators.map((a) => `@${a}`).join(', ')}`, '');
md.push(
  `1. The author of #${failingPr.number} should inspect the failed combined state (${diagnosis.failed_combination.map((n) => `#${n}`).join(' + ')}).`,
);
let step = 2;
if (interactionFound) {
  md.push(
    `${step++}. Coordinate with ${relatedEarlier.map((p) => `the author of #${p.number}`).join(' and ')}, because the failing tests involve code changed there.`,
  );
}
md.push(`${step++}. Fix the appropriate source PR branch and push the fix.`);
md.push(`${step++}. Re-run that PR's individual CI.`);
md.push(`${step++}. Rebuild the release candidate.`);
writeFileSync(path.join(state, 'diagnosis.md'), md.join('\n') + '\n');

if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, 'diagnosed=true\n');
console.log(md.join('\n'));
