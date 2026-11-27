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
  /** Virtual sidebar folder within the project (UI only; the session still runs in the project folder). */
  folder_id: string | null;
  created_at: string;
  updated_at: string;
  /** When something was last said in it (a message sent, or an answer), else null. Computed, not stored. */
  last_activity: string | null;
  /** The first thing the user sent (first 300 chars), for tooltips. Computed, not stored. */
  first_message: string | null;
};

/** A sidebar folder grouping sessions inside a project. Purely a UI aid: nothing on disk. */
/** `position`: order within the project (you drag folders to reorder them). */
export type FolderRow = { id: string; project: string; name: string; position: number; created_at: string };

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
      CREATE TABLE IF NOT EXISTS folders (
        id TEXT PRIMARY KEY,
        project TEXT NOT NULL,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
    const cols = this.db.query<{ name: string }, []>("PRAGMA table_info(sessions)").all();
    if (!cols.some((c) => c.name === "folder_id")) this.db.exec("ALTER TABLE sessions ADD COLUMN folder_id TEXT");
    const fcols = this.db.query<{ name: string }, []>("PRAGMA table_info(folders)").all();
    if (!fcols.some((c) => c.name === "position")) {
      // Folders used to be sorted by name: keep that as the starting order.
      this.db.exec("ALTER TABLE folders ADD COLUMN position INTEGER NOT NULL DEFAULT 0");
      this.db.exec(`UPDATE folders SET position = (SELECT COUNT(*) FROM folders f2 WHERE f2.project = folders.project
        AND (f2.name COLLATE NOCASE < folders.name COLLATE NOCASE OR (f2.name COLLATE NOCASE = folders.name COLLATE NOCASE AND f2.id < folders.id)))`);
    }
  }

  now() {
    return new Date().toISOString();
  }

  createSession(s: Pick<SessionRow, "id" | "project" | "harness" | "title" | "model" | "effort" | "permission_mode"> & { folder_id?: string | null }) {
    const t = this.now();
    this.db
      .query(
        `INSERT INTO sessions (id, project, harness, title, model, effort, permission_mode, folder_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(s.id, s.project, s.harness, s.title, s.model, s.effort, s.permission_mode, s.folder_id ?? null, t, t);
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

  /** Copy one session's event log into another (same seq and timestamps), e.g. for a fork. */
  copyEvents(from: string, to: string) {
    this.db.query("INSERT INTO events (session_id, seq, ts, data) SELECT ?, seq, ts, data FROM events WHERE session_id = ?").run(to, from);
  }

  deleteSession(id: string) {
    this.db.query("DELETE FROM events WHERE session_id = ?").run(id);
    this.db.query("DELETE FROM sessions WHERE id = ?").run(id);
  }

  folders() {
    return this.db.query<FolderRow, []>("SELECT * FROM folders ORDER BY project, position, created_at").all();
  }

  folder(id: string) {
    return this.db.query<FolderRow, [string]>("SELECT * FROM folders WHERE id = ?").get(id) ?? undefined;
  }

  /** New folders go at the bottom of their project. */
  createFolder(f: Pick<FolderRow, "id" | "project" | "name">) {
    this.db
      .query(
        `INSERT INTO folders (id, project, name, position, created_at)
         VALUES (?, ?, ?, (SELECT COALESCE(MAX(position), -1) + 1 FROM folders WHERE project = ?), ?)`,
      )
      .run(f.id, f.project, f.name, f.project, this.now());
    return this.folder(f.id)!;
  }

  renameFolder(id: string, name: string) {
    this.db.query("UPDATE folders SET name = ? WHERE id = ?").run(name, id);
    return this.folder(id);
  }

  /** Put a project's folders in this order. Unknown ids are ignored; folders not listed keep their order, after these. */
  reorderFolders(project: string, ids: string[]) {
    const current = this.folders().filter((f) => f.project === project).map((f) => f.id);
    const listed = ids.filter((id, i) => current.includes(id) && ids.indexOf(id) === i);
    const order = [...listed, ...current.filter((id) => !listed.includes(id))];
    const set = this.db.query("UPDATE folders SET position = ? WHERE id = ?");
    this.db.transaction(() => order.forEach((id, i) => set.run(i, id)))();
  }

  /** Delete a folder; its sessions go back to the project root. Returns the ids of the sessions that moved. */
  deleteFolder(id: string): string[] {
    const moved = this.db.query<{ id: string }, [string]>("SELECT id FROM sessions WHERE folder_id = ?").all(id).map((r) => r.id);
    this.db.query("UPDATE sessions SET folder_id = NULL WHERE folder_id = ?").run(id);
    this.db.query("DELETE FROM folders WHERE id = ?").run(id);
    return moved;
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
