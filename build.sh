#!/usr/bin/env bash
# Build dist/ for radify: dist/bin/app (Bun-compiled server, linux x64) + dist/static (UI).
set -euo pipefail
cd "$(dirname "$0")"
bun install --frozen-lockfile >/dev/null
bunx tsc --noEmit -p .
bun test server web
bunx vite build --config web/vite.config.ts
mkdir -p dist/bin
bun build server/main.ts --compile --minify --target=bun-linux-x64 --outfile dist/bin/app
ls -la dist/bin/app
