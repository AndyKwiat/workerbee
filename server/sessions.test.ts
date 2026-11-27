import { expect, test } from "bun:test";
import { Store } from "./db";
import { SessionManager, type Broadcast } from "./sessions";
import type { Harness, HarnessSession, OpenOptions, Sink, UserInput } from "./harness/types";

/** Scripted harness: echoes text, asks permission when the message contains "tool". */
class FakeHarness implements Harness {
  id = "fake";
  label = "Fake";
  opened: OpenOptions[] = [];
  sessions: { sink: Sink; closed: boolean }[] = [];
  open(opts: OpenOptions, sink: Sink): HarnessSession {
    this.opened.push(opts);
    const st = { sink, closed: false };
    this.sessions.push(st);
    sink.harnessSessionId(opts.resumeId ?? "h-" + this.opened.length);
    return {
      send: async (i: UserInput) => {
        sink.delta({ kind: "text", text: "ec" });
        if (i.text.includes("tool")) {
          const d = await sink.permission({ request_id: "r1", tool: "Bash", input: { command: "ls" } }, new AbortController().signal);
          sink.event({ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } });
          sink.event({ type: "tool_result", tool_use_id: "t1", content: d.decision });
        }
        sink.event({ type: "text", text: "echo: " + i.text });
        sink.event({ type: "turn_end", ok: true });
      },
      interrupt: async () => {},
      setModel: async () => {},
      setPermissionMode: async () => {},
      close: () => {
        st.closed = true;
        sink.closed();
      },
    };
  }
  models = async () => [];
  usage = async () => ({ ok: false as const, error: "n/a", fetched_at: "" });
  auth = {
    status: async () => ({ loggedIn: true }),
    startLogin: async () => ({ loggedIn: true }),
    submitCode: async () => ({ loggedIn: true }),
    logout: async () => ({ loggedIn: false }),
  };
}

function setup(idle = 50) {
  const store = new Store(":memory:");
  const h = new FakeHarness();
  const out: Broadcast[] = [];
  const mgr = new SessionManager(store, { fake: h }, (p) => "/tmp/" + p, (m) => out.push(m), idle);
  return { store, h, out, mgr };
}

test("send creates a live session, titles it, records events and goes idle", async () => {
  const { store, h, out, mgr } = setup();
  const s = mgr.create({ project: "p", harness: "fake" });
  mgr.send(s.id, { text: "hello there" });
  await Bun.sleep(5);
  const ev = store.events(s.id).map((r) => r.event.type);
  expect(ev).toEqual(["user", "text", "turn_end"]);
  const row = store.session(s.id)!;
  expect(row.title).toBe("hello there");
  expect(row.status).toBe("idle");
  expect(row.harness_session_id).toBe("h-1");
  expect(h.opened[0].cwd).toBe("/tmp/p");
  expect(out.some((m) => m.type === "delta")).toBe(true);
});

test("permission round trip", async () => {
  const { store, mgr } = setup();
  const s = mgr.create({ project: "p", harness: "fake" });
  mgr.send(s.id, { text: "use a tool" });
  await Bun.sleep(5);
  expect(store.session(s.id)!.status).toBe("waiting");
  mgr.answerPermission("r1", { decision: "allow" });
  await Bun.sleep(5);
  const ev = store.events(s.id).map((r) => r.event);
  expect(ev.map((e) => e.type)).toEqual(["user", "permission_request", "permission_resolved", "tool_use", "tool_result", "text", "turn_end"]);
  expect((ev[4] as any).content).toBe("allow");
  expect(() => mgr.answerPermission("r1", { decision: "allow" })).toThrow();
});

test("idle close, then resume with the harness session id", async () => {
  const { h, mgr, store } = setup(20);
  const s = mgr.create({ project: "p", harness: "fake" });
  mgr.send(s.id, { text: "one" });
  await Bun.sleep(60);
  expect(h.sessions[0].closed).toBe(true);
  expect(mgr.liveCount()).toBe(0);
  mgr.send(s.id, { text: "two" });
  await Bun.sleep(5);
  expect(h.opened[1].resumeId).toBe("h-1");
  expect(store.events(s.id).filter((r) => r.event.type === "turn_end").length).toBe(2);
});

test("restart marks running sessions idle and expires open permissions", () => {
  const store = new Store(":memory:");
  const s = store.createSession({ id: "x", project: "p", harness: "fake", title: "", model: null, effort: null, permission_mode: "default" });
  store.updateSession(s.id, { status: "waiting" });
  store.appendEvent(s.id, { type: "permission_request", request_id: "r9", tool: "Bash", input: {} });
  new SessionManager(store, { fake: new FakeHarness() }, () => "/tmp", () => {}, 1000);
  expect(store.session("x")!.status).toBe("idle");
  const last = store.events("x").at(-1)!.event as any;
  expect(last).toEqual({ type: "permission_resolved", request_id: "r9", decision: "expired" });
});

test("context is recorded once per session; resumes add only what's new", async () => {
  const store = new Store(":memory:");
  let extra = false;
  const h = new FakeHarness();
  const open = h.open.bind(h);
  h.open = (opts, sink) => {
    sink.event({ type: "context", model: "m1", skills: ["radify"], files: [{ path: "~/.claude/CLAUDE.md", scope: "user", reason: "session start" }] });
    if (extra) sink.event({ type: "context", files: [{ path: "./CLAUDE.md", scope: "project", reason: "session start" }] });
    return open(opts, sink);
  };
  const mgr = new SessionManager(store, { fake: h }, () => "/tmp/p", () => {}, 10);
  const s = mgr.create({ project: "p", harness: "fake" });
  mgr.send(s.id, { text: "one" });
  await Bun.sleep(40); // idle close
  extra = true;
  mgr.send(s.id, { text: "two" });
  await Bun.sleep(5);
  const ctx = store.events(s.id).filter((r) => r.event.type === "context").map((r) => r.event as any);
  expect(ctx.length).toBe(2);
  expect(ctx[1].files[0].path).toBe("./CLAUDE.md");
});

test("cleanupEmpty removes only untitled sessions with no events", async () => {
  const { store, mgr, out } = setup();
  const empty = mgr.create({ project: "p", harness: "fake" });
  const titled = mgr.create({ project: "p", harness: "fake", title: "kept" });
  const used = mgr.create({ project: "p", harness: "fake" });
  mgr.send(used.id, { text: "hi" });
  await Bun.sleep(5);
  expect(mgr.cleanupEmpty()).toEqual([empty.id]);
  expect(store.session(empty.id)).toBeUndefined();
  expect(store.session(titled.id)).toBeDefined();
  expect(store.session(used.id)).toBeDefined();
  expect(out.some((m) => m.type === "session_deleted" && m.id === empty.id)).toBe(true);
});

test("background agents keep the process open; a turn they start shows as running", async () => {
  const { store, h, out, mgr } = setup(20);
  const s = mgr.create({ project: "p", harness: "fake" });
  mgr.send(s.id, { text: "hi" });
  await Bun.sleep(5);
  const sink = h.sessions[0].sink;
  sink.background([{ task_id: "a1", description: "explore", kind: "local_agent" }]);
  const pushed = out.filter((m) => m.type === "session").at(-1) as any;
  expect(pushed.session.background.map((t: any) => t.task_id)).toEqual(["a1"]);
  await Bun.sleep(40);
  expect(h.sessions[0].closed).toBe(false); // idle timeout passed, but an agent is still working
  expect(mgr.backgroundCount()).toBe(1);

  sink.busy(); // the agent finished and woke the main thread
  expect(store.session(s.id)!.status).toBe("running");
  sink.event({ type: "text", text: "done" });
  sink.event({ type: "turn_end", ok: true });
  sink.background([]);
  expect(store.session(s.id)!.status).toBe("idle");
  await Bun.sleep(40);
  expect(h.sessions[0].closed).toBe(true);
  expect(mgr.backgroundCount()).toBe(0);
});

test("folders: move sessions in and out, rename, delete sends sessions back to the root", async () => {
  const store = new Store(":memory:");
  const pushes: Broadcast[] = [];
  const mgr = new SessionManager(store, { fake: new FakeHarness() }, () => "/tmp", (m) => pushes.push(m), 1000);
  const a = mgr.create({ project: "p", harness: "fake" });
  const b = mgr.create({ project: "q", harness: "fake" });
  const f = mgr.createFolder("p", "  Ideas  ");
  expect(f.name).toBe("Ideas");
  expect(pushes.at(-1)).toEqual({ type: "folders", folders: [f] });

  const before = store.session(a.id)!.updated_at;
  await Bun.sleep(2);
  expect((await mgr.update(a.id, { folder_id: f.id }))!.folder_id).toBe(f.id);
  expect(store.session(a.id)!.updated_at).toBe(before); // moving doesn't count as activity
  await expect(mgr.update(b.id, { folder_id: f.id })).rejects.toThrow(); // other project
  await expect(mgr.update(a.id, { folder_id: "nope" })).rejects.toThrow();

  const c = mgr.create({ project: "p", harness: "fake", folder_id: f.id });
  expect(c.folder_id).toBe(f.id);
  expect(() => mgr.create({ project: "q", harness: "fake", folder_id: f.id })).toThrow();

  expect(mgr.renameFolder(f.id, "Later")!.name).toBe("Later");
  expect(() => mgr.renameFolder(f.id, " ")).toThrow();

  pushes.length = 0;
  mgr.deleteFolder(f.id);
  expect(store.session(a.id)!.folder_id).toBeNull();
  expect(store.session(c.id)!.folder_id).toBeNull();
  expect(mgr.folders()).toEqual([]);
  expect(pushes.map((p) => p.type)).toEqual(["session", "session", "folders"]);
});

test("folder_id column is added to an existing database", () => {
  const path = `/tmp/wb-migrate-${crypto.randomUUID()}.db`;
  const { Database } = require("bun:sqlite");
  const old = new Database(path, { create: true });
  old.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, project TEXT NOT NULL, harness TEXT NOT NULL, harness_session_id TEXT,
    title TEXT NOT NULL DEFAULT '', model TEXT, effort TEXT, permission_mode TEXT NOT NULL DEFAULT 'default',
    status TEXT NOT NULL DEFAULT 'idle', archived INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
  old.exec(`INSERT INTO sessions (id, project, harness, created_at, updated_at) VALUES ('s', 'p', 'fake', 't', 't')`);
  old.close();
  const store = new Store(path);
  expect(store.session("s")!.folder_id).toBeNull();
  store.db.close();
  require("node:fs").rmSync(path, { force: true });
});

test("folders: new ones go last, reorder sets the order, other projects untouched", () => {
  const store = new Store(":memory:");
  const mgr = new SessionManager(store, { fake: new FakeHarness() }, () => "/tmp", () => {}, 1000);
  const [c, a, b] = ["c", "a", "b"].map((n) => mgr.createFolder("p", n));
  const other = mgr.createFolder("q", "z");
  const names = (proj: string) => mgr.folders().filter((f) => f.project === proj).map((f) => f.name);
  expect(names("p")).toEqual(["c", "a", "b"]); // creation order, not alphabetical
  mgr.reorderFolders("p", [b.id, c.id, "bogus", other.id]); // a not listed: stays, after the listed ones
  expect(names("p")).toEqual(["b", "c", "a"]);
  expect(names("q")).toEqual(["z"]);
  expect(mgr.createFolder("p", "d").position).toBe(3);
});

test("existing folders get positions in their old alphabetical order", () => {
  const path = `/tmp/wb-migrate-${crypto.randomUUID()}.db`;
  const { Database } = require("bun:sqlite");
  const old = new Database(path, { create: true });
  old.exec(`CREATE TABLE folders (id TEXT PRIMARY KEY, project TEXT NOT NULL, name TEXT NOT NULL, created_at TEXT NOT NULL)`);
  old.exec(`INSERT INTO folders VALUES ('1', 'p', 'beta', 't'), ('2', 'p', 'Alpha', 't'), ('3', 'p', 'gamma', 't'), ('4', 'q', 'x', 't')`);
  old.close();
  const store = new Store(path);
  expect(store.folders().map((f) => [f.project, f.name, f.position])).toEqual([
    ["p", "Alpha", 0],
    ["p", "beta", 1],
    ["p", "gamma", 2],
    ["q", "x", 0],
  ]);
  store.db.close();
  require("node:fs").rmSync(path, { force: true });
});
