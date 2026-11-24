#!/usr/bin/env bash
# Fail unless a pull request's head is a branch of this repository.
#
# Usage: require-same-repo-pr.sh <pull-request-number>
# Environment: GITHUB_REPOSITORY, and GH_TOKEN for `gh`.
#
# Outside pull requests are not accepted. A workflow that checks
# out a pull request's head with a write token runs this first. A head whose
# repository was deleted has no name and fails too.
set -euo pipefail

pr="${1:?pull request number}"
head=$(gh api "repos/$GITHUB_REPOSITORY/pulls/$pr" --jq '.head.repo.full_name // ""')
if [ "$head" != "$GITHUB_REPOSITORY" ]; then
  echo "::error::pull request #$pr comes from ${head:-a deleted repository}, not $GITHUB_REPOSITORY; stopping"
  exit 1
fi
echo "pull request #$pr is a branch of $GITHUB_REPOSITORY"
