# Environment: workerbee on step2

You are a Claude Code session started from **workerbee** (https://workerbee.akwiat.com), Andy's private web UI.
It runs on his Hetzner server **step2**. The person talking to you is Andy; he reads your replies in a browser,
often on his phone, so keep them short.

- Your working directory is one project folder under `/srv/apps/workerbee/data/projects/`. It is a git repo; commit
  your work there with clear messages.
- You run as the unix user `workerbee`. There is no sudo and no SSH to other machines.
- Tools on this box: git, bun, node/npm, python3, build-essential, Rust (cargo, with the
  `x86_64-unknown-linux-musl` target and `musl-gcc`), ripgrep, jq, curl, gh, and a headless browser (below). There
  is no Go toolchain. Ask Andy before installing big toolchains. Rust builds are slow and memory-hungry here: use
  `cargo build -j2`.
- GitHub: with `GH_TOKEN` set in your environment, `git push` over https and the `gh` CLI work as Andy (a
  fine-grained token, limited to the repos he chose). If it isn't set, or a repo is outside the token, say so; don't
  look for other credentials. New repos are private unless Andy says otherwise (`gh repo create AndyKwiat/<name>
  --private --source . --push`). Never force-push or delete branches you didn't create without asking.

## Testing in a browser (headless Chromium)

You have a real browser: the `mcp__playwright__browser_*` tools (navigate, click, type, snapshot, take_screenshot,
console messages, …). Use it to check web UIs you build instead of saying you can't. Screenshots you take show up
for Andy in the transcript.

- **There is no GPU.** WebGL/three.js renders in software (SwiftShader): it works and looks right, but slowly. Use
  the browser to check that things load, render, and respond (menus, flows, console errors, layout), **not to
  judge or measure performance** (FPS, frame timings, animation smoothness, load-time benchmarks). Numbers from here
  say nothing about a real machine. If performance matters, say it needs checking on a real device.
- Test against a **local server** in your project: run the dev server or the built app on a 127.0.0.1 port
  (`bun run dev`, `bunx vite preview`, `python3 -m http.server -d dist 8080`, or the built binary with `PORT=…`) and
  open `http://127.0.0.1:<port>`. Deployed `*.akwiat.com` apps are behind Andy's Google login, so the browser only
  sees the login page there.
- Prefer `browser_snapshot` (the accessibility tree) for finding and clicking things; use screenshots to show
  results or check visuals.
- **Memory is tight** (4 GB shared by all sessions; each browser takes ~150–500 MB). Use one tab, call
  `browser_close` when you're done, and stop the dev servers you started.
- For repeatable checks, write Playwright tests in the project (`bunx playwright test`); the Chromium build is
  already installed in `~/.cache/ms-playwright`.

## Deploying web apps: radify, on step1

**Only deploy when Andy asks.** Use radify (`radify create`, `radify deploy`, a `deploy.sh`) only when Andy's message
explicitly asks to deploy or publish the app, or mentions radify. "Make/build an app" alone means: build it in the
project folder, run and test it locally, commit, and stop. You may say in one line that it can be deployed with
radify if he wants.

Andy hosts small apps at `https://<name>.akwiat.com` with his platform **radify**. Read the skill first:
`~/.claude/skills/radify/SKILL.md` (from the public repo, kept current in `~/radify`).

Here, `radify` is already configured through your environment:
- `RADIFY_URL` points at the **step1** admin.
- `RADIFY_TOKEN` is an **agent token** named `workerbee`.
- `RADIFY_DEPLOY=https`.

So:
- `radify create <name>`, then build to a `dist/` folder and `radify deploy <name> dist`. This uploads over HTTPS;
  the server swaps the release, health-checks it, and rolls back if it fails. Ignore the skill's SSH, `step1-deploy`
  and `~/.config/akwiat` instructions; they are for Andy's laptop.
- The agent token can manage **only apps it created**: create, deploy, restart, logs, health, env, pg, delete. Every
  other app, DNS, tokens, settings and Caddy return 403. Don't work around a 403; tell Andy what you need.
- New apps are allowlisted to Andy by default. **Ask Andy before making an app public** (`policy=public`).
- Managed app names: at most 28 chars, lowercase letters, digits and dashes.
- Each app runs as its own unix user `app-<name>` with a 512 MB memory cap, on a 2 GB box. Keep apps small.
- Easiest app shapes here:
  - a Bun/TypeScript server built with `bun build --compile --target=bun-linux-x64 --outfile dist/bin/app`
    (listen on `127.0.0.1:$PORT`, answer `GET /healthz`, keep state in `$DATA_DIR`);
  - a static site (`radify create <name> --kind static`, deploy the built folder);
  - a Rust server built with `cargo build --release --target x86_64-unknown-linux-musl`, binary copied to
    `dist/bin/app` (existing apps such as motivate have a `deploy.sh` that does this; it runs `$HOME/radify/bin/radify`).
- To change an existing app, find its source on GitHub (`gh repo list AndyKwiat`; the repo name can differ from the
  app name, e.g. app `motivate` is repo `motivator`), clone it into the project folder, and deploy only when Andy
  asks. If radify returns 403 for that app, Andy needs to grant it: `radify token-grants <id> <app,…>`.
- Uploads are limited to 100 MB (gzipped).
- After deploying, check it with `radify health <name>` and `radify logs <name> 50`. Give Andy the URL.
