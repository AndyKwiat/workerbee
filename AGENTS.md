# workerbee — agent notes

A Claude-Desktop-style web UI for Claude Code sessions that run on Andy's server **step2**, using his Claude
subscription. Live at https://workerbee.akwiat.com and only the owner's Google account (`$ADMIN_EMAILS` in
`~/.config/akwiat/secrets.env`) can open it (radify Google gate, allowlist). Bun + TypeScript server, React + Vite
UI, SQLite. The public overview is `README.md`; this file is the operating manual.

## Deploy

```
./deploy.sh
```

That is the whole procedure:
1. It refuses to deploy if something that looks like a token is committed.
2. It runs `build.sh`, which does the typecheck, `bun test server`, the Vite build to `dist/static`, and
   `bun build --compile --target=bun-linux-x64` to `dist/bin/app`.
3. It runs `RADIFY_SERVER=step2 radify deploy workerbee dist`: rsync, restart, wait for `/healthz`, and roll back on
   failure.

Commit and push to `AndyKwiat/workerbee` after a deploy that works. The repo is **public**: never commit secrets,
emails, IPs or anything from `data/`.

**step2 is not step1.** step2 runs its own radify install:
- admin: https://admin-step2.akwiat.com
- CLI: **`RADIFY_SERVER=step2 radify …`**. Plain `radify` talks to step1, where workerbee does not exist.
- SSH: `ssh step2` (root), `ssh step2-deploy`.
- Background on radify: the radify skill (`~/.claude/skills/radify/SKILL.md`) and `~/radify/docs/README.md`
  ("Additional servers").

Useful commands:

```
RADIFY_SERVER=step2 radify logs workerbee 200          # also --since -2h --grep 'error'
RADIFY_SERVER=step2 radify health workerbee
RADIFY_SERVER=step2 radify restart workerbee
RADIFY_SERVER=step2 radify env workerbee               # PORT, WB_ALLOWED_EMAILS, GH_TOKEN (if set)
RADIFY_SERVER=step2 radify system                      # RAM/disk; each active claude process is ~250 MB
```

Restarting or deploying is safe mid-conversation. Sessions resume from disk, but a turn that is running at that
moment is cut off (it shows "process exited"), and so are background subagents. Before deploying, wait until
`/api/state` shows no session with a non-idle `status` and `background` is 0.

## Server layout (step2)

```
/srv/apps/workerbee/current/{bin/app,static/}     deployed release (radify)
/srv/apps/workerbee/env                           WB_ALLOWED_EMAILS, GH_TOKEN, … (radify env-set)
/srv/apps/workerbee/data/                         DATA_DIR, the only writable path, owned by user `workerbee`
  workerbee.db                                    sessions + normalized event log (what the UI shows)
  projects/<name>/                                project folders = session cwd
  home/                                           HOME for Claude:
    .local/bin/claude                             the CLI (self-updating; "Update Claude Code" in the UI)
    .claude/.credentials.json                     Claude OAuth login (made via the UI Account dialog; NEVER copy or commit)
    .claude/projects/…/<id>.jsonl                 Claude's own transcripts (used for --resume)
```

The app runs as the dedicated unix user **`workerbee`**, not radify's shared `apps` user. That way Claude's shell
cannot read other apps' env files. It also gets `MemoryMax=3G` and `HOME`/`PATH` pointing into `data/home`. This is
a systemd drop-in that radify doesn't know about. It is installed by `ops/server-setup.sh` (idempotent; it is the
source of truth for the drop-in). Rebuilding step2 means: radify new-server steps,
`RADIFY_SERVER=step2 radify create workerbee --policy allowlist --emails "$ADMIN_EMAILS"`,
`ssh step2 'bash -s' < ops/server-setup.sh`, `./deploy.sh`, then log Claude in from the UI.

Runtime env (set by radify's unit + the drop-in):

| env | value |
|---|---|
| `PORT` | 9100, bound to 127.0.0.1 |
| `DATA_DIR`, `STATIC_DIR` | radify defaults (above) |
| `HOME`, `WB_PROJECTS_DIR`, `PATH` | from the drop-in |
| `WB_ALLOWED_EMAILS` | the owner's email (`$ADMIN_EMAILS`). Checked against `X-Auth-Email` as defense in depth behind the gate |
| `GH_TOKEN` | optional. If set, a git credential helper for github.com is configured on start |
| `WB_IDLE_CLOSE_MS`, `WB_USAGE_POLL_MS` | optional overrides (10 min, 5 min; usage backs off further when rate limited) |

## Architecture

- `server/harness/types.ts` is **the contract**. It defines `Harness` and `HarnessSession` and the normalized
  `WbEvent`s (`user`, `text`, `thinking`, `tool_use`, `tool_result`, `permission_request/resolved`, `turn_end`,
  `error`, `info`), plus live-only `delta`s. The UI and `SessionManager` know only these types.
- `server/harness/claude/` is the only harness today:
  - `index.ts`: Agent SDK `query()` with a streaming input queue, `includePartialMessages`, and `canUseTool` → UI
    permission prompts. It uses the installed CLI via `pathToClaudeCodeExecutable`.
  - `auth.ts`: drives `claude auth login` headlessly. The CLI prints a URL, and the code is written to its stdin.
    The Account dialog shows that claude.ai link; you paste the code back. Credentials land in
    `data/home/.claude/.credentials.json` (mode 600) and the CLI refreshes them itself. A `claude setup-token`
    token can be pasted instead, but it may lack the scope the usage endpoint needs.
  - `usage.ts`: polls the undocumented `GET https://api.anthropic.com/api/oauth/usage`
    (`anthropic-beta: oauth-2025-04-20`), the same as Andy's SwiftBar plugin, and pushes it to the top bar
    (≥70% amber, ≥90% red). If the endpoint changes, only the top bar breaks.
- **Adding another harness** (Codex, Gemini, …): implement `Harness` in `server/harness/<name>/` and register it in
  `server/main.ts`. Sessions already store `harness` + `harness_session_id`. Don't leak SDK types past the harness
  folder, and don't make the UI read harness-specific formats.
- `server/sessions.ts` (`SessionManager`):
  - At most one live harness process per session.
  - It closes the process after idle and resumes it with `harness_session_id` on the next message.
  - It holds pending permission promises.
  - On startup it marks stale `running`/`waiting` sessions idle and expires open permission requests.
- `server/main.ts`: `Bun.serve` HTTP API under `/api/*`, a WebSocket at `/ws` (server → client pushes: `event`,
  `delta`, `session`, `usage`, `auth`, `projects`), and static files with an SPA fallback. Identity comes from
  `X-Auth-Email`. Requests that are not GET, and socket opens, must be same-origin.
- `server/projects.ts`: a project is just a directory under `projects/` (no table). It is created empty (`git init`)
  or by `git clone`.
- `web/src/api.ts` mirrors the protocol types by hand. **Change the server types → update `api.ts` too.**
  `App.tsx` holds the state and applies pushes. The other components are presentational.

## Develop and test

```
bun install
bun test server                 # SessionManager against a scripted FakeHarness (no Claude, no network)
bunx tsc --noEmit -p .
WB_DEV=1 DATA_DIR=.data bun server/main.ts              # API on 127.0.0.1:8787, trusts everyone as dev@localhost
bunx vite --config web/vite.config.ts                   # UI with /api and /ws proxied to 8787
```

- `.claude/launch.json` has a `workerbee-dev` preview config (it serves the built `dist/static`).
- Locally on macOS, Claude uses Andy's own login from the keychain. Avoid sending real prompts from local dev unless
  asked; test real turns against step2 instead.
- On the server, call the API **as the caddy user** with an allowed email in `X-Auth-Email`:
  `ssh step2 "runuser -u caddy -- curl -H 'X-Auth-Email: <allowed email>' 127.0.0.1:9100/api/…"`.
  `/api/sessions/:id/events` is handy for checking transcripts. As any other user, including root, you get 403 (see
  below).

## What sessions know: radify on step1

Every Claude session started from workerbee gets:
- `~/.claude/CLAUDE.md` (= `ops/claude-home/CLAUDE.md`, rewritten on every start; edit it here and deploy).
- The radify skill and CLI from a clone of the radify repo (private, so it needs `GH_TOKEN`) in `data/home/radify`, pulled every 6 h and
  symlinked into `~/.claude/skills/radify` and `~/.local/bin/radify`.
- `RADIFY_URL` (step1 admin), `RADIFY_TOKEN` (**agent token `workerbee`**: only apps it creates) and
  `RADIFY_DEPLOY=https` in workerbee's env file. Set with `RADIFY_SERVER=step2 radify env-set workerbee …`; never
  committed.
- Bun, so sessions can build TypeScript apps (installed by `ops/server-setup.sh`).
- A headless browser: Playwright MCP (`~/tools/playwright-mcp`, pinned) plus Chromium in `~/.cache/ms-playwright`,
  installed by `ops/server-setup.sh` and registered for every session in `browserMcp()`
  (`server/harness/claude/index.ts`): headless, isolated, 1280x800, Chromium's own sandbox on. Screenshots in tool
  results become `tool_result.images` (data: URLs, capped) and show in the transcript. There's no GPU (WebGL in
  software), and the session CLAUDE.md says not to measure performance. Browser tools prompt the first time; "Always
  allow" covers the rest of that session.

So a session can create and deploy apps on step1 and nothing else there. Grant it an existing app with
`radify token-grants <id> app1,app2` (ids from `radify tokens`, run as admin), or transfer one with
`radify set <app> owner=workerbee`.

## Security model

- Identity is `X-Auth-Email` from Caddy after the radify gate, **trusted only on connections whose socket is owned by
  the `caddy` user** (`server/peer.ts`, via /proc/net/tcp). Without that check, the Claude sessions workerbee runs
  could curl 127.0.0.1:9100 and approve their own permission prompts. Don't remove or loosen it, and don't add
  endpoints that skip `identity()` (only `/healthz` does).
- Browser side: writes and the WebSocket need `Origin` == this host (`sameOrigin()`). Every `*.akwiat.com` app is
  "same site" to the gate cookie, so SameSite=Lax alone doesn't stop another app's page. The UI is served with a
  strict CSP (`securityHeaders()`: no inline or foreign scripts, no remote images, no framing).
  `web/src/markdown.ts` renders transcript markdown with raw HTML escaped, links limited to http(s)/mailto, and
  images never loaded, because transcript text can be prompt-injected. `web/src/markdown.test.ts` covers it. Keep
  all three when touching the UI.
- radify's own local holes are closed too: Caddy's admin API is a root-only unix socket, and radify admin checks
  the same peer uid.
- Known limit: Claude runs as the same unix user as the app, so a session with shell access can read `data/`
  (including `workerbee.db` and Claude's credentials, which it needs anyway) or kill the app. Permission prompts and
  the per-session mode are the guard there. Real separation would need a second unix user for the claude
  processes.

## Rules

- **No secrets in git**:
  - The Claude login lives only in `data/home/.claude/`.
  - Other secrets go in with `radify env-set`.
  - `.gitignore` covers `.env*`, `*.token`, credentials, `.data/` and `dist/`.
- Keep `server/harness/types.ts` small and harness-neutral. Bump both sides of the protocol together.
- `MemoryMax` is 3G on a 4 GB box (+4 GB swap). Don't raise the idle-close time a lot without checking
  `radify system`.
- Personal use only: it runs one person's own Claude subscription on their own server. Don't add multi-user
  support or open it to other people.
- Bypass-permissions mode exists on purpose (Andy's choice per session). Don't make it the default.
