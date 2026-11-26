import { dirname, join, normalize } from "node:path";
import { existsSync, mkdirSync, symlinkSync } from "node:fs";
// @ts-ignore text import, embedded into the compiled binary
import agentClaudeMd from "../ops/claude-home/CLAUDE.md" with { type: "text" };
import type { ServerWebSocket } from "bun";
import { config } from "./config";
import { peerUid, uidOf } from "./peer";
import { Store } from "./db";
import { Projects } from "./projects";
import { Files, fileResponse } from "./files";
import { SessionManager, type Broadcast } from "./sessions";
import { ClaudeHarness, claudeBin } from "./harness/claude";
import type { Harness, PermissionDecision, Usage } from "./harness/types";

const store = new Store(config.dbPath);
const projects = new Projects(config.projectsDir);
const files = new Files(config.filesDir);
files.cleanup();
setInterval(() => files.cleanup(), 6 * 3600_000);
const claude = new ClaudeHarness(config.home);
const harnesses: Record<string, Harness> = { [claude.id]: claude };
const defaultHarness = claude.id;

type Push = Broadcast | { type: "usage"; harness: string; usage: Usage } | { type: "auth"; harness: string; auth: unknown } | { type: "projects" };
const sockets = new Set<ServerWebSocket<unknown>>();
function publish(m: Push) {
  const s = JSON.stringify(m);
  for (const ws of sockets) ws.send(s);
}

const sessions = new SessionManager(store, harnesses, (p) => projects.path(p), publish, config.idleCloseMs);

// ---------- usage poller ----------
const usage: Record<string, Usage> = {};
// last good reading survives restarts/deploys, so a rate-limited first poll still shows numbers
for (const h of Object.values(harnesses)) {
  const saved = store.get(`usage:${h.id}`);
  if (saved) usage[h.id] = { ...JSON.parse(saved), stale: "restarted; refreshing" };
}
let lastPoll = 0;
let usageTimer: ReturnType<typeof setTimeout> | undefined;
/**
 * Poll every harness's usage. Every `usagePollMs` normally. On a failure, keep showing the last good numbers
 * (marked stale) and wait longer: Retry-After if given, else double the interval, up to an hour.
 * `force` (the refresh button) is ignored within a minute of the last poll.
 */
async function pollUsage(force = false) {
  if (force && Date.now() - lastPoll < 60_000) return;
  lastPoll = Date.now();
  clearTimeout(usageTimer);
  let next = config.usagePollMs;
  for (const h of Object.values(harnesses)) {
    let u: Usage;
    try {
      u = await h.usage();
    } catch (e: any) {
      u = { ok: false, error: e?.message ?? String(e), fetched_at: new Date().toISOString() };
    }
    const prev = usage[h.id];
    if (!u.ok) {
      next = Math.max(next, (u.retry_after_s ?? 0) * 1000, Math.min((usageBackoff[h.id] ?? config.usagePollMs) * 2, 3600_000));
      usageBackoff[h.id] = next;
      console.warn(`usage ${h.id}: ${u.error}; next try in ${Math.round(next / 1000)}s`);
      if (prev?.ok) u = { ...prev, stale: u.error };
    } else {
      delete usageBackoff[h.id];
      store.set(`usage:${h.id}`, JSON.stringify(u));
    }
    usage[h.id] = u;
    publish({ type: "usage", harness: h.id, usage: u });
  }
  usageTimer = setTimeout(() => pollUsage(), next);
}
const usageBackoff: Record<string, number> = {};
pollUsage();

// ---------- one-time environment setup ----------
async function setupEnv() {
  if (config.ghToken) {
    const helper = `!f() { echo username=x-access-token; echo "password=$GH_TOKEN"; }; f`;
    await Bun.spawn(["git", "config", "--global", "credential.https://github.com.helper", helper]).exited;
  }
  if (!config.dev) {
    // commit identity is set once on the server (git config --global user.name/user.email); default only if unset
    const hasName = (await Bun.spawn(["git", "config", "--global", "user.name"], { stdout: "pipe" }).exited) === 0;
    if (!hasName) await Bun.spawn(["git", "config", "--global", "user.name", "workerbee"]).exited;
    await Bun.spawn(["git", "config", "--global", "init.defaultBranch", "main"]).exited;
    if (!claudeBin(config.home)) {
      console.log("installing Claude Code CLI into", config.home);
      const p = Bun.spawn(["bash", "-c", "curl -fsSL https://claude.ai/install.sh | bash"], { cwd: config.home, stdout: "inherit", stderr: "inherit" });
      await p.exited;
    }
    await setupAgentHome();
    setInterval(() => setupAgentHome().catch((e) => console.error("agent home refresh failed", e)), 6 * 3600_000);
  }
}
setupEnv().catch((e) => console.error("setup failed", e));

/**
 * What every Claude session should know: a global CLAUDE.md (shipped in this repo) plus the radify skill and CLI
 * from the radify repo (private; cloned with GH_TOKEN), kept current with a pull. Credentials come from the environment (radify env-set).
 */
async function setupAgentHome() {
  const home = config.home;
  await Bun.write(join(home, ".claude/CLAUDE.md"), agentClaudeMd);
  const rd = join(home, "radify");
  const git = (args: string[]) => Bun.spawn(["git", ...args], { cwd: home, stdout: "ignore", stderr: "inherit" }).exited;
  if (!existsSync(join(rd, ".git"))) await git(["clone", "-q", "--depth", "1", "https://github.com/AndyKwiat/radify.git", rd]);
  else await git(["-C", rd, "pull", "-q", "--ff-only"]);
  for (const [link, target] of [
    [join(home, ".claude/skills/radify"), join(rd, "skills/radify")],
    [join(home, ".local/bin/radify"), join(rd, "bin/radify")],
  ]) {
    mkdirSync(dirname(link), { recursive: true });
    if (!existsSync(link)) symlinkSync(target, link);
  }
}

// ---------- http ----------
const json = (data: unknown, status = 200) => Response.json(data, { status });
const fail = (msg: string, status = 400) => json({ error: msg }, status);

const proxyUid = config.dev ? null : uidOf(process.env.WB_PROXY_USER ?? "caddy");
if (!config.dev && proxyUid === null) console.error("no 'caddy' user: every request will be rejected");

/**
 * The signed-in user, or null. X-Auth-Email is set by Caddy after the radify gate, but anything on this box
 * (including the Claude sessions we run) can connect to 127.0.0.1 and send that header itself, so it only counts
 * on connections owned by the caddy user (see peer.ts).
 */
function identity(req: Request, peer: { address: string; port: number } | null): string | null {
  if (config.dev) return "dev@localhost";
  if (!peer || proxyUid === null || peerUid(peer.address, peer.port, config.port) !== proxyUid) return null;
  const email = (req.headers.get("x-auth-email") ?? "").toLowerCase();
  if (!email) return null;
  if (config.allowedEmails.length && !config.allowedEmails.includes(email)) return null;
  return email;
}

/** Reject cross-site writes / socket opens (the gate cookie is SameSite=Lax, this is belt and braces). */
function sameOrigin(req: Request) {
  // The gate cookie is SameSite=Lax for all of *.akwiat.com, so any app page on the domain is "same site": a write
  // or socket must come from this exact host. Host (set by Caddy) rather than X-Forwarded-Host (client-suppliable).
  const origin = req.headers.get("origin");
  if (!origin) return req.headers.get("sec-fetch-site") === "same-origin";
  try {
    return new URL(origin).host === req.headers.get("host");
  } catch {
    return false;
  }
}

/** Browser hardening for the UI: no inline/foreign scripts, no remote images (exfiltration), no framing. */
function securityHeaders(host: string | null): Record<string, string> {
  const wss = host ? ` wss://${host}` : "";
  return {
    "content-security-policy":
      `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; ` +
      `connect-src 'self'${wss}; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`,
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  };
}

async function body<T = any>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    return {} as T;
  }
}

async function serveStatic(pathname: string, host: string | null) {
  const root = normalize(config.staticDir);
  let p = normalize(join(root, decodeURIComponent(pathname)));
  if (!p.startsWith(root)) return new Response("forbidden", { status: 403 });
  let f = Bun.file(p);
  if (pathname.endsWith("/") || !(await f.exists())) f = Bun.file(join(root, "index.html"));
  if (!(await f.exists())) return new Response("UI not built", { status: 404 });
  const cache = pathname.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache";
  return new Response(f, { headers: { "cache-control": cache, ...securityHeaders(host) } });
}

function harnessOf(name: string | null) {
  const h = harnesses[name ?? defaultHarness];
  if (!h) throw new Error("unknown harness");
  return h;
}

async function api(req: Request, url: URL, me: string): Promise<Response> {
  const parts = url.pathname.split("/").filter(Boolean).slice(1); // drop "api"
  const m = req.method;
  const [a, b, c, d] = parts;

  if (a === "state" && m === "GET") {
    return json({
      me,
      harnesses: Object.values(harnesses).map((h) => ({ id: h.id, label: h.label })),
      defaultHarness,
      projects: projects.list(),
      sessions: store.sessions().map((s) => sessions.decorate(s)),
      usage,
      live: sessions.liveCount(),
      background: sessions.backgroundCount(),
    });
  }

  if (a === "projects") {
    if (!b && m === "GET") return json(projects.list());
    if (!b && m === "POST") {
      const { name, gitUrl } = await body(req);
      const p = await projects.create(String(name ?? "").trim(), gitUrl ? String(gitUrl).trim() : undefined);
      publish({ type: "projects" });
      return json(p, 201);
    }
  }

  if (a === "files" && !b && m === "POST") {
    const name = url.searchParams.get("name") ?? "file";
    return json(await files.save(name, await req.arrayBuffer()), 201);
  }

  if (a === "sessions") {
    if (!b && m === "POST") {
      const p = await body(req);
      projects.path(String(p.project ?? "")); // validates
      if (!projects.list().some((x) => x.name === p.project)) return fail("no such project", 404);
      return json(sessions.create({ project: p.project, harness: p.harness ?? defaultHarness, model: p.model, effort: p.effort, permission_mode: p.permission_mode }), 201);
    }
    if (b === "cleanup" && !c && m === "POST") return json({ deleted: sessions.cleanupEmpty() });
    if (b && !c && m === "GET") {
      const s = store.session(b);
      return s ? json(sessions.decorate(s)) : fail("not found", 404);
    }
    if (b && !c && m === "PATCH") return json(await sessions.update(b, await body(req)));
    if (b && !c && m === "DELETE") {
      sessions.delete(b);
      return json({ ok: true });
    }
    if (b && c === "events" && m === "GET") return json(store.events(b, Number(url.searchParams.get("after") ?? 0)));
    if (b && c === "messages" && m === "POST") {
      const { text, images } = await body(req);
      sessions.send(b, { text: String(text ?? ""), images: Array.isArray(images) ? images.slice(0, 8) : undefined });
      return json({ ok: true });
    }
    if (b && c === "interrupt" && m === "POST") {
      await sessions.interrupt(b);
      return json({ ok: true });
    }
    if (b && c === "tasks" && d && parts[4] === "stop" && m === "POST") {
      await sessions.stopTask(b, d);
      return json({ ok: true });
    }
  }

  if (a === "permissions" && b && m === "POST") {
    const p = await body(req);
    const d: PermissionDecision =
      p.decision === "deny" ? { decision: "deny", message: p.message } : { decision: p.decision === "allow_always" ? "allow_always" : "allow" };
    if (p.updatedInput && d.decision !== "deny") (d as any).updatedInput = p.updatedInput;
    sessions.answerPermission(b, d);
    return json({ ok: true });
  }

  if (a === "harness" && b) {
    const h = harnessOf(b);
    if (c === "models" && m === "GET") return json(await h.models());
    if (c === "usage" && m === "POST") {
      await pollUsage(true);
      return json(usage[h.id]);
    }
    if (c === "version" && m === "GET") return json({ version: (await h.version?.()) ?? "" });
    if (c === "update" && m === "POST") return json({ output: (await h.update?.()) ?? "not supported" });
    if (c === "auth") {
      let st;
      if (!d && m === "GET") st = await h.auth.status();
      else if (d === "login" && m === "POST") st = await h.auth.startLogin();
      else if (d === "code" && m === "POST") st = await h.auth.submitCode(String((await body(req)).code ?? ""));
      else if (d === "logout" && m === "POST") st = await h.auth.logout();
      if (st) {
        if (d) {
          publish({ type: "auth", harness: h.id, auth: st });
          if (d === "code" || d === "logout") pollUsage();
        }
        return json(st);
      }
    }
  }

  return fail("not found", 404);
}

const server = Bun.serve({
  port: config.port,
  hostname: "127.0.0.1",
  idleTimeout: 120,
  maxRequestBodySize: 200 * 1024 * 1024,
  async fetch(req, srv) {
    const url = new URL(req.url);
    if (url.pathname === "/healthz") return new Response("ok");

    const me = identity(req, srv.requestIP(req));
    if (!me) return new Response("forbidden", { status: 403 });

    if (url.pathname === "/ws") {
      if (!sameOrigin(req)) return new Response("bad origin", { status: 403 });
      return srv.upgrade(req) ? undefined : new Response("upgrade failed", { status: 400 });
    }
    if (url.pathname.startsWith("/files/") && req.method === "GET") {
      const p = files.resolve(url.pathname.slice("/files/".length));
      return p ? fileResponse(p) : new Response("not found (files are deleted after 7 days)", { status: 404 });
    }
    if (url.pathname.startsWith("/api/")) {
      if (req.method !== "GET" && !sameOrigin(req)) return fail("bad origin", 403);
      try {
        return await api(req, url, me);
      } catch (e: any) {
        return fail(e?.message ?? String(e), 400);
      }
    }
    return serveStatic(url.pathname, req.headers.get("host"));
  },
  websocket: {
    idleTimeout: 120,
    sendPings: true,
    open(ws) {
      sockets.add(ws);
    },
    close(ws) {
      sockets.delete(ws);
    },
    message(ws, msg) {
      if (msg === "ping") ws.send('{"type":"pong"}');
    },
  },
});

console.log(`workerbee listening on ${server.hostname}:${server.port} (data ${config.dataDir}, static ${config.staticDir}, claude ${claudeBin(config.home) ?? "bundled"})`);
if (!existsSync(config.staticDir)) console.warn(`static dir ${config.staticDir} missing`);

for (const sig of ["SIGTERM", "SIGINT"] as const)
  process.on(sig, () => {
    sessions.shutdown();
    process.exit(0);
  });
