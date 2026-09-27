#!/usr/bin/env bash
# Step 12: render the job summary from whatever state earlier steps recorded (runs on failure too).
# Env: CANDIDATE_ID, PRS_INPUT, BASE_MAIN_SHA, BASE_MAIN_TREE_SHA, RUNNER_TEMP, GITHUB_STEP_SUMMARY
set -uo pipefail

state="$RUNNER_TEMP/poc-state"
STATUS="" FAILURE_TYPE="" FAILED_PR="" FAILED_PR_TITLE="" PASSED_PRS="" FAILED_COMBINATION=""
CANDIDATE_SHA="" CANDIDATE_TREE_SHA=""
# shellcheck source=/dev/null
[[ -f "$state/result.env" ]] && source "$state/result.env"
STATUS=${STATUS:-FAILED}

{
  if [[ "$STATUS" == VALIDATED ]]; then
    echo "## Candidate $CANDIDATE_ID"
  else
    echo "## Candidate $CANDIDATE_ID - $STATUS"
  fi
  echo
  echo "**Base main:** \`${BASE_MAIN_SHA:-unknown}\` (tree \`${BASE_MAIN_TREE_SHA:-unknown}\`)"
  echo
  echo "**Requested PRs:** \`$PRS_INPUT\`"
  echo
  [[ -n "$FAILURE_TYPE" ]] && echo "**Failure type:** $FAILURE_TYPE" && echo

  if [[ -f "$state/errors.txt" ]]; then
    echo "### Input validation failed - candidate was not created"
    echo
    sed 's/^/- ❌ /' "$state/errors.txt"
    echo
  fi

  if [[ -f "$state/prs.json" ]]; then
    echo "### Selected PRs"
    echo
    echo "| | PR | Title | Author | Head SHA | Candidate state |"
    echo "|---|---|---|---|---|---|"
    jq -r '.[] | "\(.number)\t\(.title)\t\(.author // "unknown")\t\(.head_sha)"' "$state/prs.json" |
      while IFS=$'\t' read -r number title author sha; do
        icon="⏸️" result="NOT RUN"
        if [[ ",$PASSED_PRS," == *",#$number,"* || "$STATUS" =~ ^(VALIDATED|STALE)$ ]]; then
          icon="✅" result="PASS"
        fi
        [[ "$number" == "$FAILED_PR" ]] && icon="❌" result="FIRST FAILING ADDITION"
        echo "| $icon | #$number | ${title//|/\\|} | @$author | \`${sha:0:12}\` | $result |"
      done
    echo
  fi

  if [[ -s "$state/steps.tsv" ]]; then
    echo "### Combined validation"
    echo
    while IFS=$'\t' read -r label result; do
      if [[ "$result" == PASS ]]; then echo "- ✅ $label"; else echo "- ❌ $label — **$result**"; fi
    done <"$state/steps.tsv"
    echo
  fi

  case "$STATUS" in
    VALIDATED)
      echo "**Candidate SHA:** \`$CANDIDATE_SHA\`"
      echo
      echo "**Candidate tree:** \`$CANDIDATE_TREE_SHA\`"
      echo
      echo "**Status:** VALIDATED — manifest uploaded as \`candidate-manifest-$CANDIDATE_ID\`"
      ;;
    FAILED)
      if [[ -n "$FAILED_PR" ]]; then
        echo "**First failing addition:** #$FAILED_PR - $FAILED_PR_TITLE"
        echo
        echo "**Passed combination:** ${PASSED_PRS:-none}"
        echo
        echo "**Failed combination:** $FAILED_COMBINATION"
        echo
        echo "PR #$FAILED_PR is the first addition after which the combined candidate failed." \
          "The root cause may be PR #$FAILED_PR itself or an interaction with earlier PRs."
        echo
        if [[ -f "$state/test-diagnosis.md" ]]; then
          cat "$state/test-diagnosis.md"
          echo
          echo "Diagnosis artifacts: \`candidate-diagnosis-$CANDIDATE_ID\`"
        fi
      else
        echo "**Status:** FAILED — the workflow stopped unexpectedly; see the step logs."
      fi
      ;;
    STALE)
      echo "### Candidate is stale"
      echo
      sed 's/^/- ⚠️ /' "$state/stale.txt"
      echo
      echo "The candidate was not accepted. Start a new run to rebuild it from the latest state."
      ;;
  esac
} >>"$GITHUB_STEP_SUMMARY"
