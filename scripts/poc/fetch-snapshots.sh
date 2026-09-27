#!/usr/bin/env bash
# Step 4: fetch the exact head SHA captured for each PR (not the branch, which may move).
# The token is passed only to these git commands and is never persisted in .git/config.
# Env: GH_TOKEN, RUNNER_TEMP
set -euo pipefail

state="$RUNNER_TEMP/poc-state"
export GIT_CONFIG_COUNT=1
export GIT_CONFIG_KEY_0="http.https://github.com/.extraheader"
basic_auth=$(printf 'x-access-token:%s' "$GH_TOKEN" | base64 | tr -d '\n')
export GIT_CONFIG_VALUE_0="AUTHORIZATION: basic $basic_auth"

jq -r '.[] | "\(.number) \(.head_sha)"' "$state/prs.json" | while read -r number sha; do
  git fetch --no-tags --quiet origin "$sha"
  git cat-file -e "$sha^{commit}"
  echo "PR #$number  head_sha: $sha  (fetched)"
done
