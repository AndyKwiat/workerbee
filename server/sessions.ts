import type { Store, SessionRow, FolderRow } from "./db";
import type { BackgroundTask, Harness, HarnessSession, PermissionDecision, PermissionMode, PermissionRequest, UserInput, WbDelta, WbEvent } from "./harness/types";

export type Broadcast =
  | { type: "event"; session_id: string; seq: number; ts: string; event: WbEvent }
  | { type: "delta"; session_id: string; delta: WbDelta }
  | { type: "session"; session: LiveSessionRow }
  | { type: "session_deleted"; id: string }
  | { type: "folders"; folders: FolderRow[] };

/** A session row plus live state: the background tasks still running in its process. */
export type LiveSessionRow = SessionRow & { background: BackgroundTask[] };

type Live = { handle: HarnessSession; idle?: ReturnType<typeof setTimeout> };
type Pending = { sessionId: string; resolve: (d: PermissionDecision) => void };

export class SessionManager {
  private live = new Map<string, Live>();
  private bg = new Map<string, BackgroundTask[]>();
  private pending = new Map<string, Pending>();

  constructor(
    private store: Store,
    private harnesses: Record<string, Harness>,
    private cwdFor: (project: string) => string,
    private publish: (m: Broadcast) => void,
    private idleCloseMs: number,
  ) {
    // Anything "running" when we last stopped is not running now.
    for (const s of store.sessions()) {
      if (s.status !== "idle") this.setStatus(s.id, "idle", false);
      for (const rid of this.openPermissionIds(s.id)) this.emit(s.id, { type: "permission_resolved", request_id: rid, decision: "expired" });
    }
  }

  private openPermissionIds(sessionId: string) {
    const open = new Set<string>();
    for (const r of this.store.events(sessionId)) {
      if (r.event.type === "permission_request") open.add(r.event.request_id);
      if (r.event.type === "permission_resolved") open.delete(r.event.request_id);
    }
    return [...open];
  }

  /** Context items (files, skills, model) already recorded per session, so resumes don't repeat the card. */
  private seenContext = new Map<string, Set<string>>();

  private contextKeys(e: Extract<WbEvent, { type: "context" }>) {
    return [
      ...(e.files ?? []).map((f) => `file:${f.path}`),
      ...(e.skills ?? []).map((k) => `skill:${k}`),
      ...(e.mcp ?? []).map((k) => `mcp:${k}`),
      ...(e.model ? [`model:${e.model}`] : []),
      ...(e.version ? [`version:${e.version}`] : []),
    ];
  }

  /** Record only what's new; returns false if nothing was. */
  private recordContext(sessionId: string, e: Extract<WbEvent, { type: "context" }>) {
    let seen = this.seenContext.get(sessionId);
    if (!seen) {
      seen = new Set();
      for (const r of this.store.events(sessionId)) if (r.event.type === "context") for (const k of this.contextKeys(r.event)) seen.add(k);
      this.seenContext.set(sessionId, seen);
    }
    const fresh = this.contextKeys(e).filter((k) => !seen!.has(k));
    if (!fresh.length) return false;
    fresh.forEach((k) => seen!.add(k));
    return true;
  }

  /** When each session's current turn started (first went running), for timing turns that end without duration_ms. */
  private turnStart = new Map<string, number>();

  private emit(sessionId: string, event: WbEvent) {
    if (event.type === "context" && !this.recordContext(sessionId, event)) return;
    const row = this.store.appendEvent(sessionId, event);
    if (event.type === "turn_end") {
      const start = this.turnStart.get(sessionId);
      this.turnStart.delete(sessionId);
      const dur = event.duration_ms && event.duration_ms > 0 ? event.duration_ms : start ? new Date(row.ts).getTime() - start : 0;
      if (dur > 0) this.store.recordTurn({ session_id: sessionId, ended_at: row.ts, duration_ms: dur, ok: event.ok, cost_usd: event.cost_usd ?? null });
    }
    this.publish({ type: "event", ...row });
  }

  /** The row as the UI sees it: with its running background tasks. */
  decorate(s: SessionRow): LiveSessionRow {
    return { ...s, background: this.bg.get(s.id) ?? [] };
  }

  private publishSession(s: SessionRow | null | undefined) {
    if (s) this.publish({ type: "session", session: this.decorate(s) });
  }

  private setStatus(id: string, status: SessionRow["status"], touch = true) {
    if (status === "running" && !this.turnStart.has(id)) this.turnStart.set(id, Date.now());
    this.publishSession(this.store.updateSession(id, { status }, touch));
  }

  private harnessFor(s: SessionRow) {
    const h = this.harnesses[s.harness];
    if (!h) throw new Error(`unknown harness ${s.harness}`);
    return h;
  }

  create(p: { project: string; harness: string; model?: string | null; effort?: string | null; permission_mode?: PermissionMode; title?: string; folder_id?: string | null }) {
    if (!this.harnesses[p.harness]) throw new Error(`unknown harness ${p.harness}`);
    const folder = p.folder_id ? this.store.folder(p.folder_id) : null;
    if (folder === undefined || (folder && folder.project !== p.project)) throw new Error("no such folder in this project");
    const s = this.store.createSession({
      id: crypto.randomUUID(),
      project: p.project,
      harness: p.harness,
      title: p.title ?? "",
      model: p.model ?? null,
      effort: p.effort ?? null,
      permission_mode: p.permission_mode ?? "default",
      folder_id: folder?.id ?? null,
    });
    this.publishSession(s);
    return this.decorate(s);
  }

  private ensureLive(s: SessionRow): Live {
    const existing = this.live.get(s.id);
    if (existing) return existing;
    const id = s.id;
    const sink = {
      event: (e: WbEvent) => {
        this.emit(id, e);
        if (e.type === "turn_end") {
          this.setStatus(id, "idle");
          this.armIdle(id);
        }
      },
      delta: (d: WbDelta) => this.publish({ type: "delta", session_id: id, delta: d }),
      harnessSessionId: (hid: string) => {
        const cur = this.store.session(id);
        if (cur && cur.harness_session_id !== hid) {
          this.publishSession(this.store.updateSession(id, { harness_session_id: hid }, false));
        }
      },
      permission: (req: PermissionRequest, signal: AbortSignal) =>
        new Promise<PermissionDecision>((resolve) => {
          this.pending.set(req.request_id, { sessionId: id, resolve });
          this.emit(id, { type: "permission_request", ...req });
          this.setStatus(id, "waiting");
          signal.addEventListener("abort", () => {
            if (this.pending.delete(req.request_id)) {
              this.emit(id, { type: "permission_resolved", request_id: req.request_id, decision: "expired" });
              resolve({ decision: "deny", message: "Cancelled." });
            }
          });
        }),
      background: (tasks: BackgroundTask[]) => {
        const was = this.bg.get(id)?.length ?? 0;
        if (tasks.length) this.bg.set(id, tasks);
        else this.bg.delete(id);
        if (!was && !tasks.length) return;
        const l = this.live.get(id);
        if (tasks.length && l?.idle) clearTimeout(l.idle);
        if (!tasks.length) this.armIdle(id);
        this.publishSession(this.store.session(id));
      },
      busy: () => {
        // A turn the agent started itself (a background task finished): show it as working until its turn_end.
        const cur = this.store.session(id);
        if (cur?.status !== "idle") return;
        const l = this.live.get(id);
        if (l?.idle) clearTimeout(l.idle);
        this.setStatus(id, "running");
      },
      closed: (err?: string) => {
        const l = this.live.get(id);
        if (l?.idle) clearTimeout(l.idle);
        this.live.delete(id);
        if (this.bg.delete(id)) this.publishSession(this.store.session(id));
        for (const [rid, p] of this.pending)
          if (p.sessionId === id) {
            this.pending.delete(rid);
            this.emit(id, { type: "permission_resolved", request_id: rid, decision: "expired" });
          }
        const cur = this.store.session(id);
        if (cur && cur.status !== "idle") {
          if (err) this.emit(id, { type: "error", message: err });
          this.emit(id, { type: "turn_end", ok: false, error: err ?? "process exited" });
          this.setStatus(id, "idle");
        } else if (err) this.emit(id, { type: "error", message: err });
      },
    };
    const handle = this.harnessFor(s).open(
      {
        cwd: this.cwdFor(s.project),
        resumeId: s.harness_session_id,
        model: s.model,
        effort: s.effort,
        permissionMode: s.permission_mode,
      },
      sink,
    );
    const l: Live = { handle };
    this.live.set(id, l);
    return l;
  }

  private armIdle(id: string) {
    const l = this.live.get(id);
    if (!l) return;
    if (l.idle) clearTimeout(l.idle);
    l.idle = setTimeout(() => {
      const s = this.store.session(id);
      // Background agents live in this process: closing it would kill them.
      if (s?.status === "idle" && !this.bg.get(id)?.length) this.close(id);
    }, this.idleCloseMs);
  }

  send(id: string, input: UserInput) {
    const s = this.store.session(id);
    if (!s) throw new Error("no such session");
    if (!input.text.trim() && !input.images?.length) throw new Error("empty message");
    if (!s.title) {
      const t = input.text.trim().replace(/\s+/g, " ").slice(0, 60);
      this.publishSession(this.store.updateSession(id, { title: t || "Image" }));
    }
    const l = this.ensureLive(s);
    if (l.idle) clearTimeout(l.idle);
    this.emit(id, { type: "user", text: input.text, images: input.images?.length || undefined });
    this.setStatus(id, "running");
    l.handle.send(input);
  }

  answerPermission(requestId: string, d: PermissionDecision) {
    const p = this.pending.get(requestId);
    if (!p) throw new Error("permission request is no longer pending");
    this.pending.delete(requestId);
    this.emit(p.sessionId, { type: "permission_resolved", request_id: requestId, decision: d.decision });
    this.setStatus(p.sessionId, "running");
    p.resolve(d);
  }

  async interrupt(id: string) {
    const l = this.live.get(id);
    if (!l) return;
    for (const [rid, p] of this.pending)
      if (p.sessionId === id) {
        this.pending.delete(rid);
        this.emit(id, { type: "permission_resolved", request_id: rid, decision: "deny" });
        p.resolve({ decision: "deny", message: "Interrupted by the user." });
      }
    await l.handle.interrupt();
  }

  async update(id: string, patch: { title?: string; model?: string | null; effort?: string | null; permission_mode?: PermissionMode; archived?: boolean; folder_id?: string | null }) {
    const s = this.store.session(id);
    if (!s) throw new Error("no such session");
    if (patch.folder_id !== undefined) {
      // Moving between folders is UI-only: it doesn't touch updated_at, and the folder must be in the same project.
      const f = patch.folder_id === null ? null : this.store.folder(patch.folder_id);
      if (f === undefined || (f && f.project !== s.project)) throw new Error("no such folder in this project");
      const moved = this.store.updateSession(id, { folder_id: f?.id ?? null }, false);
      const { folder_id: _, ...rest } = patch;
      if (!Object.keys(rest).length) {
        this.publishSession(moved);
        return moved && this.decorate(moved);
      }
      patch = rest;
    }
    const l = this.live.get(id);
    if (patch.model !== undefined && l) await l.handle.setModel(patch.model);
    if (patch.permission_mode && l) await l.handle.setPermissionMode(patch.permission_mode);
    // Effort is a launch option: restart the process lazily so the next turn picks it up.
    if (patch.effort !== undefined && l && s.status === "idle") this.close(id);
    const u = this.store.updateSession(id, {
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.model !== undefined ? { model: patch.model } : {}),
      ...(patch.effort !== undefined ? { effort: patch.effort } : {}),
      ...(patch.permission_mode ? { permission_mode: patch.permission_mode } : {}),
      ...(patch.archived !== undefined ? { archived: patch.archived ? 1 : 0 } : {}),
    });
    this.publishSession(u);
    return u && this.decorate(u);
  }

  async stopTask(id: string, taskId: string) {
    const l = this.live.get(id);
    if (!l?.handle.stopTask) throw new Error("no running task to stop");
    await l.handle.stopTask(taskId);
  }

  /** Sessions with background agents still running (a restart would kill them). */
  backgroundCount() {
    return [...this.bg.values()].filter((t) => t.length).length;
  }

  close(id: string) {
    const l = this.live.get(id);
    if (!l) return;
    if (l.idle) clearTimeout(l.idle);
    this.live.delete(id);
    if (this.bg.delete(id)) this.publishSession(this.store.session(id));
    l.handle.close();
  }

  /**
   * A new session that starts from a copy of this one's conversation and then goes its own way. Same project,
   * folder and settings; the transcript is copied so the UI shows the shared history.
   */
  async fork(id: string) {
    const s = this.store.session(id);
    if (!s) throw new Error("no such session");
    if (!s.harness_session_id) throw new Error("nothing to fork yet: send a message first");
    if (s.status !== "idle") throw new Error("wait for the current turn to finish, then fork");
    const h = this.harnessFor(s);
    if (!h.fork) throw new Error(`${h.label} sessions can't be forked`);
    const title = `${s.title || "New session"} (fork)`;
    const hid = await h.fork(s.harness_session_id, this.cwdFor(s.project), title);
    const f = this.store.createSession({
      id: crypto.randomUUID(),
      project: s.project,
      harness: s.harness,
      title,
      model: s.model,
      effort: s.effort,
      permission_mode: s.permission_mode,
      folder_id: s.folder_id,
    });
    this.store.copyEvents(s.id, f.id);
    this.store.updateSession(f.id, { harness_session_id: hid }, false);
    this.emit(f.id, { type: "info", message: `Forked from "${s.title || "New session"}". Changes here don't affect the original, but both share the project's files.` });
    const row = this.store.session(f.id)!;
    this.publishSession(row);
    return this.decorate(row);
  }

  // ---------- sidebar folders (virtual: only the UI knows about them) ----------
  folders() {
    return this.store.folders();
  }

  private publishFolders() {
    this.publish({ type: "folders", folders: this.store.folders() });
  }

  createFolder(project: string, name: string) {
    const n = name.trim().slice(0, 100);
    if (!n) throw new Error("folder name required");
    const f = this.store.createFolder({ id: crypto.randomUUID(), project, name: n });
    this.publishFolders();
    return f;
  }

  renameFolder(id: string, name: string) {
    const n = name.trim().slice(0, 100);
    if (!n) throw new Error("folder name required");
    if (!this.store.folder(id)) throw new Error("no such folder");
    const f = this.store.renameFolder(id, n);
    this.publishFolders();
    return f;
  }

  reorderFolders(project: string, ids: string[]) {
    this.store.reorderFolders(project, ids);
    this.publishFolders();
    return this.store.folders().filter((f) => f.project === project);
  }

  /** Its sessions move to the project root. */
  deleteFolder(id: string) {
    for (const sid of this.store.deleteFolder(id)) this.publishSession(this.store.session(sid));
    this.publishFolders();
  }

  delete(id: string) {
    this.close(id);
    this.seenContext.delete(id);
    this.store.deleteSession(id);
    this.publish({ type: "session_deleted", id });
  }

  /** Delete sessions that were created but never used (untitled, no events, no live process). Returns their ids. */
  cleanupEmpty(): string[] {
    const ids = this.store.emptySessionIds().filter((id) => !this.live.has(id));
    for (const id of ids) this.delete(id);
    return ids;
  }

  liveCount() {
    return this.live.size;
  }

  shutdown() {
    for (const id of [...this.live.keys()]) this.close(id);
  }
}
