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
`main + A + B`, ...) with `npm ci`, lint, test and build. It never merges, pushes, tags or deploys.
If every state passes and neither `main` nor any selected PR moved during the run, it uploads
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

### Release queue manager

`.github/workflows/poc-queue-manager.yml` (**POC - Queue Manager**) is a developer-facing queue
on top of the candidate builder. It only orchestrates and reports: it never merges, pushes,
creates branches or changes code.

- **Commands:** comment on a PR with `/queue add`, `remove`, `hold`, `resume`, `retry` or
  `status`. On the **POC Release Queue** issue, comment `/queue status`, `build [rc-id]`,
  `freeze`, `unfreeze` or `move #PR POS`. The PR commands also work there as `/queue hold #PR`.
  Changing the queue needs write access; anyone can use `status`.
- **Visibility:** each PR gets one `queue:*` state label and one status comment that is updated
  in place. The issue shows the active queue (position, author, head SHA, state), the current
  candidate, blockers with their diagnosis, held PRs, and what `/queue build` would include.
- **State:** stored as JSON inside the issue description, so don't edit that by hand. Commands
  that change the queue run one at a time.
- **Build and results:** `/queue build` marks the active PRs `VALIDATING` and dispatches the
  candidate builder with `prs` in queue order. When that run finishes, its artifacts (manifest
  or diagnosis) update the labels, comments and dashboard. The first failing addition becomes
  `TEST_FAILED`, `MERGE_CONFLICT` or `BLOCKED`, the passing PRs before it become `VALIDATED`,
  and the queue suggests a next candidate but never drops a PR on its own.
- **Build flow:** the run started by the `/queue build` comment waits for the candidate build
  and then records its result, because builds started by the built-in token don't trigger other
  workflows. If a result is ever missing, run **POC - Queue Manager** by hand with the input
  left empty: it finds the current candidate's run and records it.
- **Workflow file on `main`:** comment commands only use the version on `main`.

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
