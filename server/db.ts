import { Database } from "bun:sqlite";
import type { PermissionMode, WbEvent } from "./harness/types";

const LAST_ACTIVITY = `(SELECT MAX(ts) FROM events e WHERE e.session_id = s.id AND json_extract(e.data, '$.type') IN ('user', 'text', 'turn_end')) AS last_activity, (SELECT substr(json_extract(e.data, '$.text'), 1, 300) FROM events e WHERE e.session_id = s.id AND json_extract(e.data, '$.type') = 'user' ORDER BY seq LIMIT 1) AS first_message`;

export type SessionRow = {
  id: string;
  project: string;
  harness: string;
  harness_session_id: string | null;
  title: string;
  model: string | null;
  effort: string | null;
  permission_mode: PermissionMode;
  status: "idle" | "running" | "waiting";
  archived: number;
  created_at: string;
  updated_at: string;
  /** When something was last said in it (a message sent, or an answer), else null. Computed, not stored. */
  last_activity: string | null;
  /** The first thing the user sent (first 300 chars), for tooltips. Computed, not stored. */
  first_message: string | null;
};

export type EventRow = { session_id: string; seq: number; ts: string; event: WbEvent };

export class Store {
  db: Database;
  constructor(path: string) {
    this.db = new Database(path, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        project TEXT NOT NULL,
        harness TEXT NOT NULL,
        harness_session_id TEXT,
        title TEXT NOT NULL DEFAULT '',
        model TEXT,
        effort TEXT,
        permission_mode TEXT NOT NULL DEFAULT 'default',
        status TEXT NOT NULL DEFAULT 'idle',
        archived INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        session_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        ts TEXT NOT NULL,
        data TEXT NOT NULL,
        PRIMARY KEY (session_id, seq)
      );
      CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);
    `);
  }

  now() {
    return new Date().toISOString();
  }

  createSession(s: Pick<SessionRow, "id" | "project" | "harness" | "title" | "model" | "effort" | "permission_mode">) {
    const t = this.now();
    this.db
      .query(
        `INSERT INTO sessions (id, project, harness, title, model, effort, permission_mode, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(s.id, s.project, s.harness, s.title, s.model, s.effort, s.permission_mode, t, t);
    return this.session(s.id)!;
  }

  session(id: string) {
    return this.db.query<SessionRow, [string]>(`SELECT s.*, ${LAST_ACTIVITY} FROM sessions s WHERE id = ?`).get(id) ?? undefined;
  }

  sessions() {
    return this.db.query<SessionRow, []>(`SELECT s.*, ${LAST_ACTIVITY} FROM sessions s ORDER BY updated_at DESC`).all();
  }

  updateSession(id: string, patch: Partial<Omit<SessionRow, "id" | "created_at" | "last_activity" | "first_message">>, touch = true) {
    const keys = Object.keys(patch) as (keyof typeof patch)[];
    if (!keys.length) return this.session(id);
    const sets = keys.map((k) => `${k} = ?`);
    const vals: any[] = keys.map((k) => patch[k] as any);
    if (touch) {
      sets.push("updated_at = ?");
      vals.push(this.now());
    }
    this.db.query(`UPDATE sessions SET ${sets.join(", ")} WHERE id = ?`).run(...vals, id);
    return this.session(id);
  }

  /** Sessions nobody ever used: no title and no events at all. */
  emptySessionIds(): string[] {
    return this.db
      .query<{ id: string }, []>("SELECT id FROM sessions s WHERE title = '' AND NOT EXISTS (SELECT 1 FROM events e WHERE e.session_id = s.id)")
      .all()
      .map((r) => r.id);
  }

  deleteSession(id: string) {
    this.db.query("DELETE FROM events WHERE session_id = ?").run(id);
    this.db.query("DELETE FROM sessions WHERE id = ?").run(id);
  }

  appendEvent(sessionId: string, event: WbEvent): EventRow {
    const ts = this.now();
    const row = this.db
      .query<{ seq: number }, [string]>("SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM events WHERE session_id = ?")
      .get(sessionId)!;
    this.db.query("INSERT INTO events (session_id, seq, ts, data) VALUES (?, ?, ?, ?)").run(sessionId, row.seq, ts, JSON.stringify(event));
    return { session_id: sessionId, seq: row.seq, ts, event };
  }

  events(sessionId: string, after = 0): EventRow[] {
    return this.db
      .query<{ session_id: string; seq: number; ts: string; data: string }, [string, number]>(
        "SELECT * FROM events WHERE session_id = ? AND seq > ? ORDER BY seq",
      )
      .all(sessionId, after)
      .map((r) => ({ session_id: r.session_id, seq: r.seq, ts: r.ts, event: JSON.parse(r.data) }));
  }

  get(k: string) {
    return this.db.query<{ v: string }, [string]>("SELECT v FROM kv WHERE k = ?").get(k)?.v;
  }
  set(k: string, v: string) {
    this.db.query("INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(k, v);
  }
}
