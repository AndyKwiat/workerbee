# workerbee 🐝

A Claude-Desktop-style web UI for [Claude Code](https://claude.com/claude-code) sessions that run on my own server.
I start a session from my phone, close the tab, and it keeps working; when I come back the transcript has caught
up. Sessions can build, test and deploy apps to my self-hosted platform (radify), and they have a headless browser
to check their own work.

![workerbee: a session transcript with the sidebar of projects and the usage bar](docs/workerbee.png)

## What it does

- **Projects and sessions.** A project is a folder on the server: empty, a `git clone`, or a new GitHub repo. Each
  project holds any number of Claude sessions, which you can rename, archive and resume.
- **Live transcript.** Streaming text and thinking, tool calls with collapsible input and output, diffs for edits,
  screenshots from the agent's browser, image paste in the composer, and a Stop button.
- **Permission prompts in the browser.** "Allow Bash: `bun test`?" shows up in the UI. Model, effort and
  permission mode can be picked per session.
- **Sessions outlive the tab.** Reopen from any device and pick up where it left off. A `claude` process only runs
  while a session is working (plus a short idle window), then it's closed and resumed from disk on the next
  message, so idle sessions cost no memory.
- **Usage bar.** 5-hour, weekly and Opus usage with reset countdowns, pushed live to every open tab.
- **Account dialog.** Log Claude in on the server from the browser (OAuth), no SSH needed.
- **Agents can ship.** Every session gets the radify CLI with a scoped *agent token*: it can create and deploy its
  own apps, and nothing else on the platform.

## How it's built

The server is Bun + TypeScript, compiled into a single binary. The UI is React. Sessions run through the
[Claude Agent SDK](https://docs.claude.com/en/api/agent-sdk/overview), and everything they do gets saved to
SQLite, which is why you can close the tab and come back later.

It sits behind the same Google login as the rest of my apps. The agents run on the same box, so I made sure they
can't talk to workerbee's API directly and approve their own permission prompts. Agent output also gets rendered
carefully, since anything a model reads off the web could try to sneak something in.

## Running it

It's built for one person's own server and Claude subscription, not as a hosted multi-user service.

```
bun install
bun test server                                        # SessionManager against a scripted fake harness
WB_DEV=1 DATA_DIR=.data bun server/main.ts             # API on 127.0.0.1:8787 (dev mode trusts everyone)
bunx vite --config web/vite.config.ts                  # UI with /api and /ws proxied to 8787
```

Deploying (`./deploy.sh`) and operating it are covered in [AGENTS.md](AGENTS.md), which is written for both the
coding agents that work on this repo and humans.

No secrets live in this repo: Claude's login stays in the server's data directory, and other settings are
environment variables on the server.
