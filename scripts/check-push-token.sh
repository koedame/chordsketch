#!/usr/bin/env bash
# check-push-token.sh — Prove a GitHub token can push to a repository.
#
# Usage: <SECRET_NAME>=<token> scripts/check-push-token.sh <SECRET_NAME> <owner/repo>
#
# `git push --dry-run` fetches the receive-pack advertisement, which GitHub
# only serves to a token that may push, and sends nothing. That is the
# permission the publish jobs use, so it is the permission tested —
# repository read access would not do. Also prints when the token expires.
# Used by `.github/workflows/release-credentials.yml`.
set -euo pipefail

name=$1
repo=$2
token=${!name:-}

if [ -z "$token" ]; then
  echo "::error::$name is not set"
  exit 1
fi

probe=$(mktemp -d)
trap 'rm -rf "$probe"' EXIT
git init -q "$probe"
git -C "$probe" -c user.name=probe -c user.email=probe@invalid commit -q --allow-empty -m probe

if GIT_TERMINAL_PROMPT=0 git -C "$probe" push -q --dry-run \
    "https://x-access-token:${token}@github.com/${repo}.git" \
    HEAD:refs/heads/release-credentials-probe >/dev/null 2>&1; then
  echo "$name: can push to $repo"
else
  echo "::error::$name cannot push to $repo (expired, revoked, or missing contents:write)"
  exit 1
fi

expiry=$(curl -sS -o /dev/null -D - -H "Authorization: Bearer $token" https://api.github.com/rate_limit \
  | awk -F': ' 'tolower($1) == "github-authentication-token-expiration" { print $2 }' | tr -d '\r')
echo "$name expires: ${expiry:-never}"
