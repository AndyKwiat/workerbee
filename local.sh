#!/usr/bin/env bash
# Run workerbee on this machine as a desktop tool, using your own Claude login.
#
#   ./local.sh [projects-dir]
#
# Projects are the subfolders of projects-dir (default: the directory you run it from). Sessions and settings live
# in ~/.workerbee (override with WB_DATA_DIR), so they persist no matter where you launch from. Dev mode: no auth,
# bound to 127.0.0.1 only. PORT (default 8787) and WB_NO_OPEN=1 (don't open a browser) are optional.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
projects="$(cd "${1:-$PWD}" && pwd)"
data="${WB_DATA_DIR:-$HOME/.workerbee}"
port="${PORT:-8787}"
url="http://127.0.0.1:$port"

mkdir -p "$data"
cd "$here"
command -v bun >/dev/null || { echo "bun not found: curl -fsSL https://bun.sh/install | bash" >&2; exit 1; }
bun install --frozen-lockfile >/dev/null || { echo "bun install failed (old Bun? try: bun upgrade)" >&2; exit 1; }

# Build the UI if it's missing or web/ changed since the last build.
if [ ! -f dist/static/index.html ] || [ -n "$(find web package.json -newer dist/static/index.html -print -quit)" ]; then
  echo "building UI…"
  bunx vite build --config web/vite.config.ts >/dev/null
fi

if [ -z "${WB_NO_OPEN:-}" ]; then
  (
    for _ in $(seq 50); do curl -fs "$url/healthz" >/dev/null 2>&1 && break; sleep 0.2; done
    if command -v open >/dev/null; then open "$url"; elif command -v xdg-open >/dev/null; then xdg-open "$url"; fi
  ) >/dev/null 2>&1 &
fi

echo "workerbee: $url   projects: $projects   data: $data   (Ctrl-C to stop)"
# GH_TOKEN unset: otherwise startup rewrites your global git credential helper.
exec env -u GH_TOKEN WB_DEV=1 PORT="$port" DATA_DIR="$data" WB_PROJECTS_DIR="$projects" \
  STATIC_DIR="$here/dist/static" bun server/main.ts
