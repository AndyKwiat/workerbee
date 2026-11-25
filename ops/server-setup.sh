#!/usr/bin/env bash
# One-time (idempotent) server setup for workerbee on a radify server. Run from the laptop:
#   ssh step2 'bash -s' < ops/server-setup.sh   (after `RADIFY_SERVER=step2 radify create workerbee ...`)
# Creates the dedicated unix user, installs the systemd drop-in and the tools Claude needs.
set -euo pipefail
D=/srv/apps/workerbee/data
id workerbee >/dev/null 2>&1 || useradd --system --user-group --home-dir $D/home --shell /bin/bash workerbee
chown workerbee:workerbee $D && chmod 770 $D
install -d -o workerbee -g workerbee -m 700 $D/home
install -d -o workerbee -g workerbee -m 750 $D/projects
apt-get install -yq ripgrep python3 build-essential unzip jq git gh nodejs npm musl-tools file >/dev/null
install -d /etc/systemd/system/app@workerbee.service.d
cat > /etc/systemd/system/app@workerbee.service.d/override.conf <<'CONF'
# workerbee runs Claude Code, which executes arbitrary shell commands: give it its own unix user so it
# cannot read other apps env files or data, and more memory for several claude processes.
[Service]
User=workerbee
Group=workerbee
MemoryMax=3G
TasksMax=4096
Environment=HOME=/srv/apps/workerbee/data/home
Environment=WB_PROJECTS_DIR=/srv/apps/workerbee/data/projects
Environment=PATH=/srv/apps/workerbee/data/home/.local/bin:/srv/apps/workerbee/data/home/.bun/bin:/srv/apps/workerbee/data/home/.cargo/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
CONF
systemctl daemon-reload
# The app installs the Claude CLI on first start if missing; doing it here makes the first start faster.
[ -x $D/home/.local/bin/claude ] || su -s /bin/bash workerbee -c 'cd ~ && curl -fsSL https://claude.ai/install.sh | bash'
# Bun, so sessions can build TypeScript apps (bun build --compile) to deploy with radify
[ -x $D/home/.bun/bin/bun ] || su -s /bin/bash workerbee -c 'cd ~ && curl -fsSL https://bun.sh/install | bash' >/dev/null
# Rust (+ the musl target, static Linux binaries; musl-tools gives musl-gcc for C deps like bundled SQLite)
[ -x $D/home/.cargo/bin/rustup ] || su -s /bin/bash workerbee -c 'cd ~ && curl -fsSL https://sh.rustup.rs | sh -s -- -y --no-modify-path --profile minimal' >/dev/null
su -s /bin/bash workerbee -c '~/.cargo/bin/rustup target add x86_64-unknown-linux-musl' >/dev/null 2>&1
# Headless browser for sessions: Playwright MCP (registered by the app, server/harness/claude/index.ts) + Chromium
PW=$D/home/tools/playwright-mcp
su -s /bin/bash workerbee -c "mkdir -p $PW && cd $PW && { [ -f package.json ] || printf '{ \"private\": true }\n' > package.json; } && npm install --no-audit --no-fund --loglevel=error @playwright/mcp@0.0.86 >/dev/null"
(cd $PW && node node_modules/playwright/cli.js install-deps chromium >/dev/null)
su -s /bin/bash workerbee -c "cd $PW && node node_modules/playwright/cli.js install chromium >/dev/null"
echo "done; now ./deploy.sh from the laptop"
