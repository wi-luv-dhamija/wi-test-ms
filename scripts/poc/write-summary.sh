#!/usr/bin/env bash
# Step 12: render the job summary from whatever state earlier steps recorded (runs on failure too).
# Env: CANDIDATE_ID, PRS_INPUT, BASE_MAIN_SHA, BASE_MAIN_TREE_SHA, RUNNER_TEMP, GITHUB_STEP_SUMMARY
set -uo pipefail

state="$RUNNER_TEMP/poc-state"
STATUS="" FAILURE_TYPE="" FAILED_PR="" FAILED_PR_TITLE="" PASSED_PRS="" CANDIDATE_SHA="" CANDIDATE_TREE_SHA=""
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

  if [[ -f "$state/errors.txt" ]]; then
    echo "### Input validation failed - candidate was not created"
    echo
    sed 's/^/- ❌ /' "$state/errors.txt"
    echo
  fi

  if [[ -f "$state/prs.json" ]]; then
    echo "### Selected PRs"
    echo
    echo "| | PR | Title | Branch | Head SHA |"
    echo "|---|---|---|---|---|"
    jq -r '.[] | "\(.number)\t\(.title)\t\(.branch)\t\(.head_sha)"' "$state/prs.json" |
      while IFS=$'\t' read -r number title branch sha; do
        icon="⏸️"
        [[ ",$PASSED_PRS," == *",#$number,"* || "$STATUS" =~ ^(VALIDATED|STALE)$ ]] && icon="✅"
        [[ "$number" == "$FAILED_PR" ]] && icon="❌"
        echo "| $icon | #$number | ${title//|/\\|} | \`$branch\` | \`${sha:0:12}\` |"
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
        echo "**First failing addition:** PR #$FAILED_PR - $FAILED_PR_TITLE"
        echo
        echo "**Failure:** $FAILURE_TYPE"
        echo
        echo "**Passed combination:** ${PASSED_PRS:-none}"
        echo
        echo "PR #$FAILED_PR is the first addition after which the combined candidate failed." \
          "The cause may be the PR itself or an interaction with the PRs merged before it."
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
