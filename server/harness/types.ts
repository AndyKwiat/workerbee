// Harness-agnostic contract. The UI and SessionManager only know these types;
// each harness (Claude today, others later) maps its own SDK onto them.

export type PermissionMode = "default" | "acceptEdits" | "plan" | "bypassPermissions" | "auto";

/** Normalized transcript events. Persisted (except `delta`) and sent to the UI as-is. */
export type WbEvent =
  | { type: "user"; text: string; images?: number }
  | { type: "text"; text: string; parent?: string | null }
  | { type: "thinking"; text: string; parent?: string | null }
  | { type: "tool_use"; id: string; name: string; input: unknown; parent?: string | null }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean; images?: string[] /* data: URLs, e.g. browser screenshots */ }
  | { type: "permission_request"; request_id: string; tool: string; input: unknown; title?: string; description?: string }
  | { type: "permission_resolved"; request_id: string; decision: "allow" | "allow_always" | "deny" | "expired" }
  | { type: "turn_end"; ok: boolean; result?: string; duration_ms?: number; cost_usd?: number; error?: string }
  | { type: "error"; message: string }
  | { type: "info"; message: string }
  /**
   * How full the context window is: a snapshot taken at start and after every turn. Not shown in the flow; the UI
   * shows the latest one in the session header.
   */
  | {
      type: "context_usage";
      tokens: number;
      max: number;
      percentage: number;
      model?: string;
      categories: { name: string; tokens: number; kind: "used" | "free" | "buffer" | "deferred" }[];
    }
  /**
   * A subagent or background job the agent started. Emitted when it starts, when it moves to the background and when
   * it ends; the UI merges the events per task_id. `tool_use_id` is the tool call that started it (its card).
   */
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

/** Live-only streaming fragment (not persisted): main-thread text, or a running task's progress. */
export type WbDelta =
  | { kind: "text" | "thinking"; text: string }
  | { kind: "task"; task_id: string; tool_uses?: number; last_tool?: string; summary?: string; duration_ms?: number };

/** Work still running in the harness process after (or outside) a turn: background subagents, workflows. */
export type BackgroundTask = { task_id: string; description: string; kind: string };

export type UserInput = { text: string; images?: { mediaType: string; data: string }[] };

export type PermissionDecision =
  | { decision: "allow" | "allow_always" }
  | { decision: "deny"; message?: string };

export type PermissionRequest = {
  request_id: string;
  tool: string;
  input: unknown;
  title?: string;
  description?: string;
};

/** Callbacks a harness session uses to talk back to the SessionManager. */
export interface Sink {
  event(e: WbEvent): void;
  delta(d: WbDelta): void;
  /** The harness's own resumable id for this conversation (e.g. Claude session UUID). */
  harnessSessionId(id: string): void;
  /** Ask the user; resolves when they answer in the UI. */
  permission(req: PermissionRequest, signal: AbortSignal): Promise<PermissionDecision>;
  /**
   * The full set of background work still running (replace semantics). While it is non-empty the process must stay
   * open, and finishing work can start a turn on its own.
   */
  background(tasks: BackgroundTask[]): void;
  /** The main agent is working without a user message (e.g. woken by a finished background task). */
  busy(): void;
  /** The live process ended (idle close, crash, …). */
  closed(err?: string): void;
}

export type OpenOptions = {
  cwd: string;
  resumeId?: string | null;
  model?: string | null;
  effort?: string | null;
  permissionMode?: PermissionMode | null;
};

export interface HarnessSession {
  send(input: UserInput): void;
  interrupt(): Promise<void>;
  setModel(model: string | null): Promise<void>;
  setPermissionMode(mode: PermissionMode): Promise<void>;
  /** Stop one task (a subagent or background job) without interrupting the turn. */
  stopTask?(taskId: string): Promise<void>;
  close(): void;
}

export type ModelOption = { value: string; label: string; description?: string; efforts?: string[] };

/** One row in the top usage bar. `used` is 0–100. */
export type UsageWindow = { key: string; label: string; used: number; resets_at?: string | null };
/** `stale`: the latest fetch failed (reason given); `windows` are the last good numbers from `fetched_at`. */
export type Usage =
  | { ok: true; windows: UsageWindow[]; fetched_at: string; stale?: string }
  | { ok: false; error: string; fetched_at: string; retry_after_s?: number };

export type AuthStatus = {
  loggedIn: boolean;
  method?: string;
  email?: string | null;
  expiresAt?: string | null;
  /** In-progress browser login: open this URL, then paste the code. */
  pendingLoginUrl?: string | null;
  detail?: string;
};

export interface Harness {
  id: string;
  label: string;
  open(opts: OpenOptions, sink: Sink): HarnessSession;
  models(): Promise<ModelOption[]>;
  usage(): Promise<Usage>;
  auth: {
    status(): Promise<AuthStatus>;
    startLogin(): Promise<AuthStatus>;
    submitCode(code: string): Promise<AuthStatus>;
    logout(): Promise<AuthStatus>;
  };
  /** Update the harness's own CLI/runtime; returns human-readable output. */
  update?(): Promise<string>;
  version?(): Promise<string>;
}
