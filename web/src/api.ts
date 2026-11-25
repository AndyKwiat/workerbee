// Client-side mirror of the server's protocol (server/harness/types.ts, server/db.ts).

export type PermissionMode = "default" | "acceptEdits" | "plan" | "bypassPermissions" | "auto";

export type WbEvent =
  | { type: "user"; text: string; images?: number }
  | { type: "text"; text: string; parent?: string | null }
  | { type: "thinking"; text: string; parent?: string | null }
  | { type: "tool_use"; id: string; name: string; input: any; parent?: string | null }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean; images?: string[] /* data: URLs, e.g. browser screenshots */ }
  | { type: "permission_request"; request_id: string; tool: string; input: any; title?: string; description?: string }
  | { type: "permission_resolved"; request_id: string; decision: string }
  | { type: "turn_end"; ok: boolean; result?: string; duration_ms?: number; cost_usd?: number; error?: string }
  | { type: "error"; message: string }
  | { type: "info"; message: string }
  /** Context window snapshot (start and after each turn); the header shows the latest. */
  | {
      type: "context_usage";
      tokens: number;
      max: number;
      percentage: number;
      model?: string;
      categories: { name: string; tokens: number; kind: "used" | "free" | "buffer" | "deferred" }[];
    }
  /** A subagent or background job; several events per task_id, merged by the UI. */
  | {
      type: "task";
      task_id: string;
      tool_use_id?: string;
      status: TaskStatus;
      kind?: string;
      agent?: string;
      description?: string;
      background?: boolean;
      summary?: string;
      tool_uses?: number;
      duration_ms?: number;
    }
  /**
   * What the harness loaded into the session's context: instruction files (CLAUDE.md, …) and capabilities (skills,
   * model). Emitted at start and whenever more is loaded; SessionManager drops repeats, the UI merges them into one card.
   */
  | {
      type: "context";
      files?: { path: string; scope: string; reason: string }[];
      skills?: string[];
      model?: string;
      version?: string;
      mcp?: string[];
    };

export type TaskStatus = "running" | "completed" | "failed" | "stopped";
export type TaskProgress = { task_id: string; tool_uses?: number; last_tool?: string; summary?: string; duration_ms?: number };
export type WbDelta = { kind: "text" | "thinking"; text: string } | ({ kind: "task" } & TaskProgress);
export type BackgroundTask = { task_id: string; description: string; kind: string };

export type EventRow = { session_id: string; seq: number; ts: string; event: WbEvent };

export type Session = {
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
  last_activity: string | null;
  first_message: string | null;
  /** Background agents still running in the session's process (live, not stored). */
  background?: BackgroundTask[];
};

export type Project = { name: string; path: string; git: boolean; created_at: string };
export type UsageWindow = { key: string; label: string; used: number; resets_at?: string | null };
/** `stale`: the latest fetch failed (reason given); `windows` are the last good numbers from `fetched_at`. */
export type Usage =
  | { ok: true; windows: UsageWindow[]; fetched_at: string; stale?: string }
  | { ok: false; error: string; fetched_at: string; retry_after_s?: number };
export type ModelOption = { value: string; label: string; description?: string; efforts?: string[] };
export type AuthStatus = {
  loggedIn: boolean;
  method?: string;
  email?: string | null;
  expiresAt?: string | null;
  pendingLoginUrl?: string | null;
  detail?: string;
};

export type State = {
  me: string;
  harnesses: { id: string; label: string }[];
  defaultHarness: string;
  projects: Project[];
  sessions: Session[];
  usage: Record<string, Usage>;
  live: number;
  background: number;
};

export type Push =
  | { type: "event"; session_id: string; seq: number; ts: string; event: WbEvent }
  | { type: "delta"; session_id: string; delta: WbDelta }
  | { type: "session"; session: Session }
  | { type: "session_deleted"; id: string }
  | { type: "usage"; harness: string; usage: Usage }
  | { type: "auth"; harness: string; auth: AuthStatus }
  | { type: "projects" }
  | { type: "pong" };

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch("/api" + path, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (r.status === 401 || r.status === 403 || r.redirected) throw new Error("Not signed in (reload the page)");
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
  return j as T;
}

export const api = {
  state: () => call<State>("GET", "/state"),
  cleanupSessions: () => call<{ deleted: string[] }>("POST", "/sessions/cleanup"),
  projects: () => call<Project[]>("GET", "/projects"),
  createProject: (name: string, gitUrl?: string) => call<Project>("POST", "/projects", { name, gitUrl }),
  createSession: (p: { project: string; harness?: string; model?: string | null; effort?: string | null; permission_mode?: PermissionMode }) =>
    call<Session>("POST", "/sessions", p),
  updateSession: (id: string, p: Partial<{ title: string; model: string | null; effort: string | null; permission_mode: PermissionMode; archived: boolean }>) =>
    call<Session>("PATCH", `/sessions/${id}`, p),
  deleteSession: (id: string) => call("DELETE", `/sessions/${id}`),
  events: (id: string, after = 0) => call<EventRow[]>("GET", `/sessions/${id}/events?after=${after}`),
  send: (id: string, text: string, images?: { mediaType: string; data: string }[]) => call("POST", `/sessions/${id}/messages`, { text, images }),
  interrupt: (id: string) => call("POST", `/sessions/${id}/interrupt`),
  stopTask: (id: string, taskId: string) => call("POST", `/sessions/${id}/tasks/${encodeURIComponent(taskId)}/stop`),
  answer: (rid: string, decision: "allow" | "allow_always" | "deny", extra?: { message?: string; updatedInput?: unknown }) =>
    call("POST", `/permissions/${rid}`, { decision, ...extra }),
  models: (h: string) => call<ModelOption[]>("GET", `/harness/${h}/models`),
  refreshUsage: (h: string) => call<Usage>("POST", `/harness/${h}/usage`),
  version: (h: string) => call<{ version: string }>("GET", `/harness/${h}/version`),
  update: (h: string) => call<{ output: string }>("POST", `/harness/${h}/update`),
  auth: (h: string) => call<AuthStatus>("GET", `/harness/${h}/auth`),
  login: (h: string) => call<AuthStatus>("POST", `/harness/${h}/auth/login`),
  code: (h: string, code: string) => call<AuthStatus>("POST", `/harness/${h}/auth/code`, { code }),
  logout: (h: string) => call<AuthStatus>("POST", `/harness/${h}/auth/logout`),
};

/** Auto-reconnecting socket. `onOpen` fires on every (re)connect so callers can resync. */
export function connect(onMsg: (m: Push) => void, onOpen: () => void, onState: (up: boolean) => void) {
  let ws: WebSocket | null = null;
  let stopped = false;
  let delay = 500;
  let ping: ReturnType<typeof setInterval> | undefined;
  const open = () => {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.onopen = () => {
      delay = 500;
      onState(true);
      onOpen();
      ping = setInterval(() => ws?.readyState === 1 && ws.send("ping"), 25_000);
    };
    ws.onmessage = (e) => {
      try {
        onMsg(JSON.parse(e.data));
      } catch {}
    };
    ws.onclose = () => {
      clearInterval(ping);
      onState(false);
      if (!stopped) setTimeout(open, (delay = Math.min(delay * 2, 10_000)));
    };
  };
  open();
  // Phones suspend sockets in the background; reconnect as soon as we're visible again.
  const vis = () => document.visibilityState === "visible" && ws && ws.readyState > 1 && open();
  document.addEventListener("visibilitychange", vis);
  return () => {
    stopped = true;
    document.removeEventListener("visibilitychange", vis);
    ws?.close();
  };
}
