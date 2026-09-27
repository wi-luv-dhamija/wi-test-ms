#!/usr/bin/env bash
# Step 2: validate the dispatch inputs and snapshot each PR (number, title, author, branch,
# head SHA, changed files)
# into $RUNNER_TEMP/poc-state/prs.json. Fails before any merge if anything is invalid.
# Env: CANDIDATE_ID, PRS_INPUT, GITHUB_REPOSITORY, GH_TOKEN, RUNNER_TEMP
set -euo pipefail

state="$RUNNER_TEMP/poc-state"
errors=()

fail_if_errors() {
  ((${#errors[@]} == 0)) && return
  for e in "${errors[@]}"; do echo "ERROR: $e"; done
  echo "Candidate was not created."
  printf '%s\n' "${errors[@]}" >"$state/errors.txt"
  echo "STATUS=INVALID_INPUT" >>"$state/result.env"
  exit 1
}

if [[ ! "$CANDIDATE_ID" =~ ^[A-Za-z0-9._-]{1,64}$ ]]; then
  errors+=("candidate_id \"$CANDIDATE_ID\" must be 1-64 characters of letters, digits, '.', '_' or '-'.")
fi

prs="${PRS_INPUT//[[:space:]]/}"
if [[ -z "$prs" ]]; then
  errors+=("prs input is empty.")
elif [[ ! "$prs" =~ ^[1-9][0-9]*(,[1-9][0-9]*)*$ ]]; then
  errors+=("prs \"$PRS_INPUT\" must be a comma-separated list of PR numbers, e.g. 12,15,18.")
fi
fail_if_errors

IFS=, read -ra numbers <<<"$prs"
for n in $(printf '%s\n' "${numbers[@]}" | sort | uniq -d); do
  errors+=("PR #$n is listed more than once.")
done
fail_if_errors

: >"$state/prs.jsonl"
for n in "${numbers[@]}"; do
  if ! pr=$(gh api "repos/$GITHUB_REPOSITORY/pulls/$n" 2>/dev/null); then
    errors+=("PR #$n does not exist in $GITHUB_REPOSITORY.")
    continue
  fi
  pr_state=$(jq -r .state <<<"$pr")
  base=$(jq -r .base.ref <<<"$pr")
  if [[ "$(jq -r .merged <<<"$pr")" == true ]]; then
    errors+=("PR #$n is already merged.")
  elif [[ "$pr_state" != open ]]; then
    errors+=("PR #$n is $pr_state.")
  fi
  [[ "$base" != main ]] && errors+=("PR #$n targets branch \"$base\" instead of \"main\".")
  [[ "$(jq -r .draft <<<"$pr")" == true ]] && errors+=("PR #$n is a draft.")
  files=$(gh api --paginate "repos/$GITHUB_REPOSITORY/pulls/$n/files" --jq '.[].filename' | jq -Rsc 'split("\n") | map(select(length > 0))')
  jq -c --argjson files "$files" \
    '{number, title, author: .user.login, branch: .head.ref, head_sha: .head.sha, files: $files}' \
    <<<"$pr" >>"$state/prs.jsonl"
done
fail_if_errors

jq -s . "$state/prs.jsonl" >"$state/prs.json"
echo "Validated ${#numbers[@]} PR(s), in merge order:"
jq -r '.[] | "PR #\(.number)  head_sha: \(.head_sha)  branch: \(.branch)  author: @\(.author)  files: \(.files | length)  title: \(.title)"' "$state/prs.json"
