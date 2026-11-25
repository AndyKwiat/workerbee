#!/usr/bin/env bash
# Build and deploy to step2 via radify. Secrets never live in this repo: Claude's login is in the server's
# data dir, other secrets go in with `RADIFY_SERVER=step2 radify env-set workerbee KEY=...`.
set -euo pipefail
cd "$(dirname "$0")"
if git grep -nIE 'sk-ant-[A-Za-z0-9_-]{10,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}' -- . ':!deploy.sh' ; then
  echo "refusing to deploy: something that looks like a token is committed" >&2; exit 1
fi
./build.sh
RADIFY_SERVER=step2 "${RADIFY:-$HOME/radify/bin/radify}" deploy workerbee dist
