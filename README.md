# FlowBoard

A lightweight project/task dashboard built with React, TypeScript and Vite. Frontend only — tasks
are stored in `localStorage` and seeded with sample data on first load.

## Setup

Requires Node.js 24 (see `.nvmrc`).

```bash
npm install
npm run dev       # start dev server at http://localhost:5173
```

## Commands

```bash
npm run lint      # ESLint + Prettier check
npm run test      # Vitest + React Testing Library
npm run build     # type-check and production build to dist/
npm run format    # auto-format with Prettier
```

## Structure

```text
src/
  components/  presentational UI (Layout, TaskCard, TaskForm, ...)
  pages/       route pages: Dashboard (/), Tasks (/tasks), About (/about)
  hooks/       useTasks — React state bound to TaskService
  services/    TaskService (all task operations) and localStorage helpers
  types/       Task types, statuses, priorities
  utils/       date formatting, dashboard stats
  data/        seed tasks
```

To reset data, clear the `flowboard.tasks` key from localStorage.

## CI

`.github/workflows/pr-validation.yml` runs lint, test and build on every pull request targeting
`main`. Any failure fails the workflow.

## Release-candidate POC

`.github/workflows/poc-candidate-builder.yml` (**POC - Build Release Candidate**) combines the
latest `main` with an ordered list of PRs and validates each cumulative state (`main + A`,
`main + A + B`, ...) with `npm ci`, lint, test and build. It never merges or pushes to a branch.
With `stage` set to `develop` or `qa` (as the queues do), a validated candidate is tagged and
deployed; a manual run defaults to `none` (validate only). If every state passes and neither `main` nor any selected PR moved during the run, it uploads
`candidate-manifest.json` as the artifact `candidate-manifest-<candidate_id>`. The logic lives in
`scripts/poc/`.

### Test-failure diagnosis

When a cumulative state fails with `TEST_FAILED`, the workflow reads Vitest's JSON report and
adds a diagnosis to the job summary:

- the failed test files, test names, errors and first stack trace;
- which selected PRs are likely related. An earlier PR counts only if it changed the failing test
  file or the file where the error was thrown. PRs that changed other files on the stack trace
  are listed as a weaker signal;
- heuristic hints (`DATA_MODEL_OR_CONTRACT_CHANGE`, `BEHAVIOR_OR_UI_CHANGE`, `SHARED_FILE_CHANGE`,
  `SHARED_MODULE_CHANGE` or `UNKNOWN`) and suggested collaborators (the related PRs' authors).

It never names a root cause and never changes code. It uploads `vitest-report.json` and
`candidate-test-diagnosis.json` as the artifact `candidate-diagnosis-<candidate_id>`. Failure
types are `MERGE_CONFLICT`, `MERGE_FAILED`, `INSTALL_FAILED`, `LINT_FAILED`, `TEST_FAILED`,
`BUILD_FAILED`, `STALE_PR` and `STALE_MAIN`.

### Merge-conflict diagnosis

When a PR can't be merged into the cumulative candidate (`MERGE_CONFLICT`), the summary lists the
exact conflicted files, the earlier selected PRs that changed those files, and pairwise checks
(`base main + earlier PR + failing PR` for each earlier PR). The pairwise checks show which PR
reproduces the conflict on its own. They run in memory with `git merge-tree`, from the captured
base SHA and PR head SHAs, so nothing is checked out or pushed. The summary ends with suggested
collaborators and resolution steps, and `candidate-merge-diagnosis.json` is uploaded with the
diagnosis artifact.

### Develop and QA queues

Branches are cut from `main` and PRs target `main`. Each PR then moves through two queues, QA
approval and an ordered merge, each one a gate:

```text
PR ─/add develop─► Develop queue ─/add qa─► QA queue ─/approve qa─► /merge qa ─► main
   main + queued PRs checked,   main + QA PRs checked    QA signs off on    approved PRs merged
   tagged develop/rc-N,         again, tagged qa/rc-N,   each deployed PR   in queue order,
   deployed to develop          deployed to qa                              tagged YYYY.MM.DD.N
```

`.github/workflows/poc-queue-manager.yml` (**POC - Queue Manager**) runs both queues. Each has
its own issue (**POC Develop Queue**, **POC QA Queue**), labels (`develop:*`, `qa:*`) and status
comment on the PR. The workflow never merges, pushes or runs PR code.

- **Commands** are `/<command> <queue>`. On a PR: `/add develop`, `/remove develop`,
  `/hold develop`, `/resume develop`, `/retry develop`, `/status develop` (same with `qa`). On a
  queue issue: `/status <queue>`, `/revalidate <queue>`, `/freeze <queue>`,
  `/unfreeze <queue>`, `/move <queue> #PR POS`, or a PR
  command with `#PR` (e.g. `/hold qa #3`). QA only: `/approve qa`, `/unapprove qa` on a PR and
  `/merge qa` on the QA queue issue. Changing a queue needs write access.
- **Develop:** any change to the queue, or a push to `main`, builds a new candidate of the whole
  queue (after a 30-second debounce; the newest revision wins). When every cumulative state
  passes, the candidate is tagged `develop/rc-<run>` and deployed to the `develop` environment,
  and its PRs become `develop:deployed`.
- **QA:** `/add qa` only accepts a PR whose current commit was deployed by the develop queue (and
  is still in it). The QA queue checks `main` + its own PRs again, tags `qa/rc-<run>` and deploys
  to the `qa` environment. Each QA candidate re-checks that its PRs are still deployed by develop
  at the same commit; any that aren't are `qa:blocked`.
- **QA approval:** `/approve qa` on a PR records who approved which commit (`qa:approved`). It
  only works while that commit is deployed to QA. The approval survives the QA queue
  redeploying, and is dropped by new commits or the PR leaving the queue.
- **Merge:** `/merge qa` merges the approved PRs from the front of the QA queue, in queue order,
  and stops at the first PR that isn't approved (`/hold qa #N` it to let the PRs behind it go).
  It dispatches **POC - Release** (`.github/workflows/poc-release.yml`), which fast-forwards
  `main` to the QA candidate's commit for exactly those PRs. That is code that was checked
  (every prefix `main + A + B` of a candidate is), not a new merge. GitHub marks the PRs merged.
  The release is tagged `YYYY.MM.DD.N` (Asia/Kolkata date) and the queues drop the merged PRs.
  The release refuses if `main` moved or a PR changed since the QA tag was built. The
  `production` environment can add a final approval (required reviewers in its settings).
- **Failures eject:** the first failing PR leaves that queue with its diagnosis, and the rest is
  rebuilt and redeployed without it. New commits pop a PR out of both queues (`*:stale`), so it
  has to go through develop again before QA. `retry` returns it to its old place; `add` puts it
  at the end.
- **Deployment** steps in the candidate builder and release workflows are placeholders: replace
  them with the real deployment for each environment.
- **State:** stored as JSON in each queue issue's description, so don't edit that by hand.
  Queue changes run one at a time.
- **Manual revalidation:** comment `/revalidate develop` (or `qa`) on the queue issue, or run
  **POC - Queue Manager** by hand with the stage and an empty revision.

### Triggering it

The workflow file must be on `main` before GitHub shows it. The candidate always starts from
`main`, but the scripts in `scripts/poc/` come from the branch picked in **Use workflow from**, so
changes to the tooling can be tried from a branch before they are merged.

1. Go to **Actions → POC - Build Release Candidate → Run workflow**.
2. Enter `candidate_id` (e.g. `poc-001`) and `prs` as an ordered list (e.g. `12,15,18`).
3. Open the run. The job summary shows each PR, each cumulative state and the final status. On
   success, download the manifest from the run's **Artifacts** section.

Or with the GitHub CLI: `gh workflow run poc-candidate-builder.yml -f candidate_id=poc-001 -f prs=12,15,18`

### Manual test scenarios

Create PRs to `main` from short-lived branches, then run the workflow:

| Case                      | Setup                                                                                               | Expected result                                                    |
| ------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| 1. Happy path             | Three independent PRs (e.g. each adds a new component file)                                         | Every state ✅, status `VALIDATED`, manifest artifact uploaded     |
| 2. Duplicate input        | `prs = 12,15,15,18`                                                                                 | Fails in _Validate PR input_; no merge is attempted                |
| 3. Merge conflict         | PRs A and C both change the same line of one file (e.g. the About page text)                        | `main+A` ✅ … `+C` ❌ `MERGE_CONFLICT`                             |
| 4. Combined test fail     | C merges cleanly but breaks a test only together with A (e.g. A renames a label C's test relies on) | `+C` ❌ `TEST_FAILED`, PR C reported as the first failing addition |
| 5. PR changes mid-run     | Start a run, then push a commit to one selected PR before it finishes                               | Status `STALE` (PR SHA changed)                                    |
| 6. `main` changes mid-run | Start a run, then merge any other PR into `main` before it finishes                                 | Status `STALE` (main changed)                                      |

Also worth trying: a closed PR, a draft PR, a PR targeting another branch, or a PR number that
doesn't exist. Each fails validation with an error naming the PR.
