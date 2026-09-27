#!/usr/bin/env bash
# Step 10: write candidate-manifest.json for a fully validated, non-stale candidate.
# Env: CANDIDATE_ID, BASE_MAIN_SHA, BASE_MAIN_TREE_SHA, GITHUB_REPOSITORY, GITHUB_RUN_ID, RUNNER_TEMP
set -euo pipefail

state="$RUNNER_TEMP/poc-state"
# shellcheck source=/dev/null
source "$state/result.env"

jq -n \
  --arg candidate_id "$CANDIDATE_ID" \
  --arg base_main_sha "$BASE_MAIN_SHA" \
  --arg base_main_tree_sha "$BASE_MAIN_TREE_SHA" \
  --arg candidate_sha "$CANDIDATE_SHA" \
  --arg candidate_tree_sha "$CANDIDATE_TREE_SHA" \
  --arg created_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg workflow_run_id "$GITHUB_RUN_ID" \
  --arg repository "$GITHUB_REPOSITORY" \
  --slurpfile prs "$state/prs.json" \
  '{
    candidate_id: $candidate_id,
    status: "VALIDATED",
    base_main_sha: $base_main_sha,
    base_main_tree_sha: $base_main_tree_sha,
    candidate_sha: $candidate_sha,
    candidate_tree_sha: $candidate_tree_sha,
    prs: $prs[0],
    created_at: $created_at,
    workflow_run_id: $workflow_run_id,
    repository: $repository
  }' >"$state/candidate-manifest.json"

echo "STATUS=VALIDATED" >>"$state/result.env"
cat "$state/candidate-manifest.json"
