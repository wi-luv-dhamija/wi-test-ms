#!/usr/bin/env bash
# Steps 3, 5-7: create the temporary candidate branch from the captured main SHA, then merge PRs
# one at a time in the given order, running install/lint/test/build after each merge.
# Stops at the first merge conflict or failed check. Never pushes anything.
# Env: CANDIDATE_ID, BASE_MAIN_SHA, RUNNER_TEMP
set -uo pipefail

state="$RUNNER_TEMP/poc-state"
: >"$state/steps.tsv"

git switch --quiet -c "poc/candidate-$CANDIDATE_ID" "$BASE_MAIN_SHA" || exit 1
echo "Created temporary branch poc/candidate-$CANDIDATE_ID at $BASE_MAIN_SHA"

# Fixed identity and dates: the same base + PR snapshots always produce the same candidate SHA.
base_date=$(git show -s --format=%cI "$BASE_MAIN_SHA")
export GIT_AUTHOR_NAME="Candidate Builder" GIT_COMMITTER_NAME="Candidate Builder"
export GIT_AUTHOR_EMAIL="candidate-builder@users.noreply.github.com"
export GIT_COMMITTER_EMAIL="$GIT_AUTHOR_EMAIL"
export GIT_AUTHOR_DATE="$base_date" GIT_COMMITTER_DATE="$base_date"

failure=""
run_check() { # <label> <failure type> <command...>
  local label=$1 type=$2 rc
  shift 2
  echo "::group::$label output ($*)"
  "$@"
  rc=$?
  echo "::endgroup::"
  if ((rc == 0)); then
    echo "$label: PASS"
  else
    echo "$label: FAIL"
    failure=$type
  fi
  return $rc
}

report_failure() { # <pr number> <pr title>
  local passed_csv
  passed_csv=$(IFS=,; echo "${passed[*]:-}")
  {
    echo "STATUS=FAILED"
    printf 'FAILURE_TYPE=%q\nFAILED_PR=%q\nFAILED_PR_TITLE=%q\nPASSED_PRS=%q\nFAILED_COMBINATION=%q\n' \
      "$failure" "$1" "$2" "$passed_csv" "${passed_csv:+$passed_csv,}#$1"
  } >>"$state/result.env"
  # Machine-readable copy for the test-failure diagnosis.
  jq -n --arg type "$failure" --argjson pr "$1" --arg passed "$passed_csv" \
    '{failure_type: $type, failed_pr: $pr, passed_prs: ($passed | [scan("[0-9]+") | tonumber])}' \
    >"$state/failure.json"
  echo
  echo "CANDIDATE FAILED"
  echo
  echo "Candidate: $CANDIDATE_ID"
  echo "Base main: $BASE_MAIN_SHA"
  echo
  echo "Passed combination:"
  echo "${passed_csv:-(none — failed on the first PR)}"
  echo
  echo "Failed combination:"
  echo "${passed_csv:+$passed_csv,}#$1"
  echo
  echo "Failure introduced while adding:"
  echo "#$1 - $2"
  echo
  echo "Failure type:"
  echo "$failure"
  echo
  echo "PR #$1 is the first addition after which the combined candidate failed."
  echo "The cause may be the PR itself or an interaction with the PRs merged before it."
  exit 1
}

total=$(jq length "$state/prs.json")
label="main"
passed=()
for ((i = 0; i < total; i++)); do
  number=$(jq -r ".[$i].number" "$state/prs.json")
  title=$(jq -r ".[$i].title" "$state/prs.json")
  sha=$(jq -r ".[$i].head_sha" "$state/prs.json")
  label="$label + #$number"

  echo
  echo "[$((i + 1))/$total] Adding PR #$number - $title ($sha)"

  if git merge --no-ff --no-edit --quiet -m "Candidate $CANDIDATE_ID: add PR #$number ($sha)" "$sha"; then
    echo "MERGE: PASS"
  else
    conflicts=$(git diff --name-only --diff-filter=U)
    if [[ -n "$conflicts" ]]; then
      failure=MERGE_CONFLICT
      echo "MERGE: CONFLICT in:"
      git diff --name-only --diff-filter=U | sed 's/^/  /'
    else
      failure=MERGE_FAILED
      echo "MERGE: FAIL"
    fi
    git merge --abort 2>/dev/null
    printf '%s\t%s\n' "$label" "$failure" >>"$state/steps.tsv"
    report_failure "$number" "$title"
  fi

  # The JSON report is overwritten per state, so it always describes the latest test run.
  rm -f "$state/vitest-report.json"
  if run_check INSTALL INSTALL_FAILED npm ci &&
    run_check LINT LINT_FAILED npm run lint &&
    run_check TEST TEST_FAILED npm run test -- --reporter=default --reporter=json \
      --outputFile.json="$state/vitest-report.json" &&
    run_check BUILD BUILD_FAILED npm run build; then
    passed+=("#$number")
    printf '%s\tPASS\n' "$label" >>"$state/steps.tsv"
    echo
    echo "Current candidate:"
    echo "$label ✅"
  else
    printf '%s\t%s\n' "$label" "$failure" >>"$state/steps.tsv"
    report_failure "$number" "$title"
  fi
done

candidate_sha=$(git rev-parse HEAD)
candidate_tree=$(git rev-parse 'HEAD^{tree}')
printf 'CANDIDATE_SHA=%s\nCANDIDATE_TREE_SHA=%s\n' "$candidate_sha" "$candidate_tree" >>"$state/result.env"
echo
echo "All $total cumulative states passed."
echo "Candidate SHA:  $candidate_sha"
echo "Candidate tree: $candidate_tree"
