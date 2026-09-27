#!/usr/bin/env bash
# Steps 8-9: fail if any selected PR or main moved while the candidate was being built.
# The candidate is never silently updated; a new run is required.
# Env: CANDIDATE_ID, BASE_MAIN_SHA, GITHUB_REPOSITORY, GH_TOKEN, RUNNER_TEMP
set -euo pipefail

state="$RUNNER_TEMP/poc-state"
stale=()

while read -r number selected; do
  current=$(gh api "repos/$GITHUB_REPOSITORY/pulls/$number" --jq .head.sha)
  if [[ "$current" != "$selected" ]]; then
    stale+=("PR #$number changed. Selected SHA: $selected. Current SHA: $current.")
  else
    echo "PR #$number unchanged ($selected)"
  fi
done < <(jq -r '.[] | "\(.number) \(.head_sha)"' "$state/prs.json")

current_main=$(gh api "repos/$GITHUB_REPOSITORY/branches/main" --jq .commit.sha)
if [[ "$current_main" != "$BASE_MAIN_SHA" ]]; then
  stale+=("Main changed while candidate $CANDIDATE_ID was being validated. Candidate base: $BASE_MAIN_SHA. Current main: $current_main.")
else
  echo "main unchanged ($BASE_MAIN_SHA)"
fi

if ((${#stale[@]} > 0)); then
  echo "STATUS=STALE" >>"$state/result.env"
  printf '%s\n' "${stale[@]}" >"$state/stale.txt"
  echo
  echo "CANDIDATE STALE"
  for s in "${stale[@]}"; do echo "- $s"; done
  echo "Rebuild the candidate with a new run."
  exit 1
fi
