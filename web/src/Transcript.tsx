import { memo, type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { renderMarkdown } from "./markdown";
import type { BackgroundTask, EventRow, TaskProgress, WbEvent } from "./api";

const Markdown = memo(({ text }: { text: string }) => {
  const html = useMemo(() => renderMarkdown(text), [text]);
  return <div className="md" dangerouslySetInnerHTML={{ __html: html }} />;
});

/** One-line summary of a tool call, like the Desktop app's collapsed tool rows. */
function toolSummary(name: string, input: any): string {
  if (!input || typeof input !== "object") return "";
  const v = input.command ?? input.file_path ?? input.path ?? input.pattern ?? input.url ?? input.element ?? input.query ?? input.description ?? input.prompt;
  if (typeof v === "string") return v.length > 140 ? v.slice(0, 140) + "…" : v;
  if (name === "TodoWrite" && Array.isArray(input.todos)) return `${input.todos.length} todos`;
  return "";
}

function Diff({ input }: { input: any }) {
  const edits: { old_string?: string; new_string?: string }[] = Array.isArray(input?.edits) ? input.edits : [input];
  return (
    <div className="diff">
      {edits.map((e, i) => (
        <div key={i}>
          {(e.old_string ?? "").split("\n").map((l, j) => (e.old_string ? <div key={"o" + j} className="del">- {l}</div> : null))}
          {(e.new_string ?? "").split("\n").map((l, j) => (
            <div key={"n" + j} className="add">
              + {l}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function ToolInput({ name, input }: { name: string; input: any }) {
  if ((name === "Edit" || name === "MultiEdit") && input) return <Diff input={input} />;
  if (name === "Write" && typeof input?.content === "string")
    return (
      <pre className="code">
        {input.content.length > 4000 ? input.content.slice(0, 4000) + "\n…" : input.content}
      </pre>
    );
  if (name === "TodoWrite" && Array.isArray(input?.todos))
    return (
      <ul className="todos">
        {input.todos.map((t: any, i: number) => (
          <li key={i} className={t.status}>
            {t.status === "completed" ? "☑" : t.status === "in_progress" ? "◐" : "☐"} {t.content}
          </li>
        ))}
      </ul>
    );
  return <pre className="code">{JSON.stringify(input, null, 2)}</pre>;
}

/** Screenshots from tool results (browser): shown even when the card is collapsed; click to enlarge. */
function Shots({ images }: { images: string[] }) {
  const [big, setBig] = useState<number | null>(null);
  return (
    <div className="shots">
      {images.map((u, i) => (
        <img key={i} src={u} alt="screenshot" className={big === i ? "big" : ""} onClick={() => setBig(big === i ? null : i)} />
      ))}
    </div>
  );
}

function ToolCard({ use, result }: { use: Extract<WbEvent, { type: "tool_use" }>; result?: Extract<WbEvent, { type: "tool_result" }> }) {
  const [open, setOpen] = useState(false);
  const state = !result ? "pending" : result.is_error ? "error" : "done";
  return (
    <div className={`tool ${state} ${use.parent ? "sub" : ""}`}>
      <button className="tool-head" onClick={() => setOpen((o) => !o)}>
        <span className="tool-state" />
        <b>{use.name}</b> <span className="tool-sum">{toolSummary(use.name, use.input)}</span>
        <span className="caret">{open ? "▾" : "▸"}</span>
      </button>
      {result?.images && <Shots images={result.images} />}
      {open && (
        <div className="tool-body">
          <ToolInput name={use.name} input={use.input} />
          {result && <pre className={`code result ${result.is_error ? "err" : ""}`}>{result.content || "(no output)"}</pre>}
        </div>
      )}
    </div>
  );
}

/** 42s, 3m 12s, 1h 4m */
export function fmtDuration(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

type Item = { kind: "row"; row: EventRow } | { kind: "group"; rows: EventRow[] };

type TaskEv = Extract<WbEvent, { type: "task" }>;
type ToolUse = Extract<WbEvent, { type: "tool_use" }>;
type ToolResult = Extract<WbEvent, { type: "tool_result" }>;

/** Tool calls that start a subagent (shown as an agent card, never folded into a tool group). */
export const isAgentCall = (name: string) => name === "Agent" || name === "Task";

/** All `task` events merged per task_id, in start order. */
export function mergeTasks(events: EventRow[]) {
  const byId = new Map<string, TaskEv & { started: string; ended?: string }>();
  for (const { ts, event: e } of events) {
    if (e.type !== "task") continue;
    const cur = byId.get(e.task_id);
    const defined = Object.fromEntries(Object.entries(e).filter(([, v]) => v !== undefined)) as TaskEv;
    const next = { ...(cur ?? { started: ts }), ...defined } as TaskEv & { started: string; ended?: string };
    if (e.status !== "running") next.ended = ts;
    byId.set(e.task_id, next);
  }
  return byId;
}

/** Split off subagent output: the main flow, and each agent call's own rows by its tool_use id. */
export function splitSubagents(events: EventRow[]) {
  const main: EventRow[] = [];
  const children = new Map<string, EventRow[]>();
  for (const r of events) {
    const parent = (r.event as { parent?: string | null }).parent;
    if (parent) children.set(parent, [...(children.get(parent) ?? []), r]);
    else main.push(r);
  }
  return { main, children };
}

function Elapsed({ since, until }: { since: string; until?: string }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (until) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [until]);
  return <>{fmtDuration((until ? Date.parse(until) : now) - Date.parse(since))}</>;
}

/** A subagent: what it was asked, a live timer and tool count while it works, its own calls when opened. */
function AgentCard({
  use,
  ts,
  result,
  task,
  progress,
  rows,
  results,
  render,
  onStop,
}: {
  use: ToolUse;
  ts: string;
  result?: ToolResult;
  task?: TaskEv & { started: string; ended?: string };
  progress?: TaskProgress;
  rows: EventRow[];
  results: Map<string, ToolResult>;
  render: (r: EventRow) => ReactNode;
  onStop?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const input: any = use.input ?? {};
  // A background agent's tool call returns at once; the task says when it is really done.
  const running = task ? task.status === "running" : !result;
  const failed = task ? task.status === "failed" : !!result?.is_error;
  const state = running ? "pending" : failed ? "error" : "done";
  const toolCount = progress?.tool_uses ?? task?.tool_uses ?? rows.filter((r) => r.event.type === "tool_use").length;
  const lastUse = [...rows].reverse().find((r) => r.event.type === "tool_use")?.event as ToolUse | undefined;
  const now = progress?.summary ?? (lastUse ? `${lastUse.name}: ${toolSummary(lastUse.name, lastUse.input)}` : progress?.last_tool);
  const finalText = task?.background && task.summary ? task.summary : result && !task?.background ? result.content : undefined;
  return (
    <div className={`tool agent ${state}`}>
      <button className="tool-head" onClick={() => setOpen((o) => !o)}>
        {running ? <span className="spinner" /> : <span className="tool-state" />}
        <b>{input.subagent_type ?? task?.agent ?? "Agent"}</b>
        <span className="tool-sum">{input.description ?? task?.description ?? toolSummary(use.name, input)}</span>
        <span className="agent-meta muted small">
          {task?.background && <span className="badge">background</span>}
          {task?.status === "stopped" ? "stopped · " : ""}
          {toolCount ? `${toolCount} tool${toolCount === 1 ? "" : "s"} · ` : ""}
          {task?.duration_ms !== undefined && !running ? fmtDuration(task.duration_ms) : <Elapsed since={task?.started ?? ts} until={running ? undefined : task?.ended ?? (result ? ts : undefined)} />}
        </span>
        <span className="caret">{open ? "▾" : "▸"}</span>
      </button>
      {running && now && <div className="agent-now muted small">{now}</div>}
      {running && onStop && (
        <button className="agent-stop small" onClick={onStop} title="Stop this agent (the main turn keeps going)">
          Stop
        </button>
      )}
      {open && (
        <div className="tool-body group-body">
          {typeof input.prompt === "string" && (
            <details className="agent-prompt">
              <summary className="muted small">Prompt</summary>
              <div className="thinking-text">{input.prompt}</div>
            </details>
          )}
          {groupActivity(rows).map((it) =>
            it.kind === "group" ? <ToolGroup key={it.rows[0].seq} rows={it.rows} results={results} live={running} render={render} /> : render(it.row),
          )}
          {!rows.length && <div className="muted small">{running ? "Starting…" : "No activity recorded."}</div>}
          {finalText && <Markdown text={finalText} />}
        </div>
      )}
    </div>
  );
}

/**
 * Runs of agent activity (tool calls, thinking, sub-agent output) with 2+ tool calls collapse into one group.
 * Anything you need to see (Claude's own text, your messages, permission prompts, errors, turn ends) breaks a run.
 */
export function groupActivity(events: EventRow[]): Item[] {
  const out: Item[] = [];
  let run: EventRow[] = [];
  const flush = () => {
    const tools = run.filter((r) => r.event.type === "tool_use").length;
    if (tools >= 2) out.push({ kind: "group", rows: run });
    else for (const r of run) out.push({ kind: "row", row: r });
    run = [];
  };
  for (const r of events) {
    const e = r.event;
    const activity =
      (e.type === "tool_use" && !isAgentCall(e.name)) || e.type === "thinking" || e.type === "tool_result" || e.type === "context" || e.type === "context_usage" || e.type === "task" || (e.type === "text" && !!e.parent);
    if (activity) run.push(r);
    else {
      flush();
      out.push({ kind: "row", row: r });
    }
  }
  flush();
  return out;
}

function ToolGroup({
  rows,
  results,
  live,
  render,
}: {
  rows: EventRow[];
  results: Map<string, Extract<WbEvent, { type: "tool_result" }>>;
  live: boolean;
  render: (r: EventRow) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const uses = rows.map((r) => r.event).filter((e): e is Extract<WbEvent, { type: "tool_use" }> => e.type === "tool_use");
  const counts = new Map<string, number>();
  for (const u of uses) counts.set(u.name, (counts.get(u.name) ?? 0) + 1);
  const names = [...counts].sort((a, b) => b[1] - a[1]).map(([n, c]) => (c > 1 ? `${n} ×${c}` : n));
  const errors = uses.filter((u) => results.get(u.id)?.is_error).length;
  const last = uses[uses.length - 1];
  const pending = live && !results.get(last.id);
  const state = pending ? "pending" : errors ? "error" : "done";
  return (
    <div className={`tool group ${state}`}>
      <button className="tool-head" onClick={() => setOpen((o) => !o)}>
        <span className="tool-state" />
        <b>{uses.length} tool calls</b>
        <span className="tool-sum">
          {pending ? `${last.name}: ${toolSummary(last.name, last.input)}` : names.join(", ")}
          {errors ? ` · ${errors} failed` : ""}
        </span>
        <span className="caret">{open ? "▾" : "▸"}</span>
      </button>
      {open && <div className="group-body">{rows.map(render)}</div>}
    </div>
  );
}

/** Live "Working… 1m 12s" while a turn runs. */
function Working({ since, quiet }: { since?: string; quiet: boolean }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="working-row">
      {!quiet && <span className="working">●●●</span>}
      {since && <span className="muted small timer">{fmtDuration(now - Date.parse(since))}</span>}
    </div>
  );
}

function TurnEnd({ ok, error, ms }: { ok: boolean; error?: string; ms?: number }) {
  return (
    <div className={`turn-end ${ok ? "" : "err"}`}>
      {!ok && <span>Turn ended: {error ?? "error"}</span>}
      {ms !== undefined && ms >= 0 && <span className="turn-time" title="How long this turn took">{fmtDuration(ms)}</span>}
    </div>
  );
}

function AskQuestion({ input, onAnswer }: { input: any; onAnswer: (answers: Record<string, string>) => void }) {
  const qs: any[] = Array.isArray(input?.questions) ? input.questions : [];
  const [sel, setSel] = useState<Record<string, string[]>>({});
  const [other, setOther] = useState<Record<string, string>>({});
  const ready = qs.every((q) => (sel[q.question]?.length ?? 0) > 0 || other[q.question]?.trim());
  return (
    <div className="ask">
      {qs.map((q) => (
        <div key={q.question} className="ask-q">
          <div>
            <b>{q.header ? `${q.header}: ` : ""}</b>
            {q.question}
          </div>
          <div className="ask-opts">
            {(q.options ?? []).map((o: any) => {
              const on = sel[q.question]?.includes(o.label);
              return (
                <button
                  key={o.label}
                  className={on ? "on" : ""}
                  title={o.description}
                  onClick={() =>
                    setSel((s) => {
                      const cur = s[q.question] ?? [];
                      const next = q.multiSelect ? (on ? cur.filter((x) => x !== o.label) : [...cur, o.label]) : [o.label];
                      return { ...s, [q.question]: next };
                    })
                  }
                >
                  {o.label}
                  {o.description && <span className="muted small"> — {o.description}</span>}
                </button>
              );
            })}
            <input placeholder="Other…" value={other[q.question] ?? ""} onChange={(e) => setOther((s) => ({ ...s, [q.question]: e.target.value }))} />
          </div>
        </div>
      ))}
      <button
        className="primary"
        disabled={!ready}
        onClick={() => {
          const answers: Record<string, string> = {};
          for (const q of qs) answers[q.question] = other[q.question]?.trim() || (sel[q.question] ?? []).join(", ");
          onAnswer(answers);
        }}
      >
        Answer
      </button>
    </div>
  );
}

function Permission({
  ev,
  resolved,
  onAnswer,
}: {
  ev: Extract<WbEvent, { type: "permission_request" }>;
  resolved?: string;
  onAnswer: (rid: string, d: "allow" | "allow_always" | "deny", extra?: { message?: string; updatedInput?: unknown }) => void;
}) {
  const [busy, setBusy] = useState(false);
  const answer = (d: "allow" | "allow_always" | "deny", extra?: any) => {
    setBusy(true);
    onAnswer(ev.request_id, d, extra);
  };
  const isAsk = ev.tool === "AskUserQuestion";
  if (resolved)
    return (
      <div className={`perm resolved ${resolved}`}>
        {isAsk ? "Question" : ev.tool} · {resolved === "allow_always" ? "always allowed" : resolved === "allow" ? (isAsk ? "answered" : "allowed") : resolved === "deny" ? "denied" : "expired"}
        {!isAsk && <span className="tool-sum"> {toolSummary(ev.tool, ev.input)}</span>}
      </div>
    );
  return (
    <div className="perm open">
      <div className="perm-title">{isAsk ? "Claude has a question" : ev.title ?? `Allow ${ev.tool}?`}</div>
      {ev.description && <div className="muted small">{ev.description}</div>}
      {isAsk ? (
        <AskQuestion input={ev.input} onAnswer={(answers) => answer("allow", { updatedInput: { ...ev.input, answers } })} />
      ) : (
        <>
          <ToolInput name={ev.tool} input={ev.input} />
          <div className="perm-actions">
            <button disabled={busy} onClick={() => answer("deny", { message: prompt("Tell Claude why (optional)") ?? undefined })}>
              Deny
            </button>
            <button disabled={busy} onClick={() => answer("allow_always")}>
              Always allow
            </button>
            <button disabled={busy} className="primary" onClick={() => answer("allow")}>
              Allow
            </button>
          </div>
        </>
      )}
    </div>
  );
}

type Ctx = Extract<WbEvent, { type: "context" }>;

/** All `context` events of a session merged: what Claude had loaded (instruction files, skills, model). */
function mergeContext(events: EventRow[]) {
  const files = new Map<string, { path: string; scope: string; reason: string }>();
  const skills = new Set<string>();
  const mcp = new Set<string>();
  let model: string | undefined;
  let version: string | undefined;
  let any = false;
  for (const { event: e } of events) {
    if (e.type !== "context") continue;
    any = true;
    for (const f of (e as Ctx).files ?? []) if (!files.has(f.path)) files.set(f.path, f);
    (e as Ctx).skills?.forEach((k) => skills.add(k));
    (e as Ctx).mcp?.forEach((k) => mcp.add(k));
    model = (e as Ctx).model ?? model;
    version = (e as Ctx).version ?? version;
  }
  return any ? { files: [...files.values()], skills: [...skills], mcp: [...mcp], model, version } : null;
}

function ContextCard({ ctx }: { ctx: NonNullable<ReturnType<typeof mergeContext>> }) {
  const n = ctx.files.length;
  return (
    <details className="ctx-card">
      <summary>
        Loaded context · {n} instruction file{n === 1 ? "" : "s"} · {ctx.skills.length} skill{ctx.skills.length === 1 ? "" : "s"}
        {ctx.model ? ` · ${ctx.model}` : ""}
      </summary>
      <div className="ctx-body">
        <div className="ctx-label">Instruction files</div>
        {n ? (
          <ul>
            {ctx.files.map((f) => (
              <li key={f.path}>
                <code>{f.path}</code> <span className="muted small">{[f.scope, f.reason].filter(Boolean).join(" · ")}</span>
              </li>
            ))}
          </ul>
        ) : (
          <div className="muted small">none (no CLAUDE.md found; AGENTS.md is only read if a CLAUDE.md imports it)</div>
        )}
        <div className="ctx-label">Skills</div>
        <div className="ctx-chips">{ctx.skills.length ? ctx.skills.map((k) => <span key={k}>{k}</span>) : <span className="muted small">none</span>}</div>
        {ctx.mcp.length > 0 && (
          <>
            <div className="ctx-label">MCP servers</div>
            <div className="ctx-chips">{ctx.mcp.map((k) => <span key={k}>{k}</span>)}</div>
          </>
        )}
        <div className="muted small">
          {ctx.model && <>model {ctx.model}</>}
          {ctx.version && <> · Claude Code {ctx.version}</>}
        </div>
      </div>
    </details>
  );
}

export function Transcript({
  events,
  stream,
  status,
  progress,
  background,
  onStopTask,
  onAnswer,
}: {
  events: EventRow[];
  stream: { text: string; thinking: string };
  status: string;
  progress: Record<string, TaskProgress>;
  background: BackgroundTask[];
  onStopTask: (taskId: string) => void;
  onAnswer: (rid: string, d: "allow" | "allow_always" | "deny", extra?: { message?: string; updatedInput?: unknown }) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  const { results, resolved } = useMemo(() => {
    const results = new Map<string, Extract<WbEvent, { type: "tool_result" }>>();
    const resolved = new Map<string, string>();
    for (const r of events) {
      if (r.event.type === "tool_result") results.set(r.event.tool_use_id, r.event);
      if (r.event.type === "permission_resolved") resolved.set(r.event.request_id, r.event.decision);
    }
    return { results, resolved };
  }, [events]);
  const ctx = useMemo(() => mergeContext(events), [events]);
  const tasks = useMemo(() => mergeTasks(events), [events]);
  const taskByUse = useMemo(() => new Map([...tasks.values()].filter((t) => t.tool_use_id).map((t) => [t.tool_use_id!, t])), [tasks]);
  const { main, children } = useMemo(() => splitSubagents(events), [events]);
  const items = useMemo(() => groupActivity(main), [main]);
  // When the current turn started: the first event after the last turn end (a user message, or a finished
  // background agent that woke Claude up).
  const turnStart = useMemo(() => {
    let start: string | undefined;
    for (let i = events.length - 1; i >= 0 && events[i].event.type !== "turn_end"; i--)
      if (!(events[i].event as any).parent && events[i].event.type !== "context_usage") start = events[i].ts;
    return start;
  }, [events]);
  const userTs = useMemo(() => {
    // For each turn_end, the ts of the user message that started it (fallback when the harness gives no duration).
    const m = new Map<number, string>();
    let last: string | undefined;
    for (const r of events) {
      if (r.event.type === "user") last = r.ts;
      if (r.event.type === "turn_end" && last) m.set(r.seq, last);
    }
    return m;
  }, [events]);

  const renderRow = ({ seq, ts, event: e }: EventRow): ReactNode => {
          switch (e.type) {
            case "user":
              return (
                <div key={seq} className="msg user">
                  {e.images ? <div className="muted small">📎 {e.images} image(s)</div> : null}
                  <div className="user-text">{e.text}</div>
                </div>
              );
            case "text":
              return (
                <div key={seq} className={`msg assistant ${e.parent ? "sub" : ""}`}>
                  <Markdown text={e.text} />
                </div>
              );
            case "thinking":
              return (
                <details key={seq} className={`thinking ${e.parent ? "sub" : ""}`}>
                  <summary>Thinking</summary>
                  <div className="thinking-text">{e.text}</div>
                </details>
              );
            case "tool_use":
              if (isAgentCall(e.name)) {
                const task = taskByUse.get(e.id);
                return (
                  <AgentCard
                    key={seq}
                    use={e}
                    ts={ts}
                    result={results.get(e.id)}
                    task={task}
                    progress={task && progress[task.task_id]}
                    rows={children.get(e.id) ?? []}
                    results={results}
                    render={renderRow}
                    onStop={task ? () => onStopTask(task.task_id) : undefined}
                  />
                );
              }
              return <ToolCard key={seq} use={e} result={results.get(e.id)} />;
            case "task": {
              // A background agent finishing is what wakes Claude up again: say so in the flow.
              const t = tasks.get(e.task_id);
              if (e.status === "running" || !t?.background) return null;
              return (
                <div key={seq} className={`task-done ${e.status}`}>
                  {e.status === "completed" ? "✓" : e.status === "failed" ? "✕" : "■"} Background {t.agent ?? "agent"} {e.status}: {t.description}
                  {t.duration_ms !== undefined && <span className="turn-time"> {fmtDuration(t.duration_ms)}</span>}
                </div>
              );
            }
            case "permission_request":
              return <Permission key={seq} ev={e} resolved={resolved.get(e.request_id)} onAnswer={onAnswer} />;
            case "turn_end":
              return <TurnEnd key={seq} ok={e.ok} error={e.error} ms={e.duration_ms ?? (userTs.has(seq) ? Date.parse(ts) - Date.parse(userTs.get(seq)!) : undefined)} />;
            case "error":
              return (
                <div key={seq} className="turn-end err">
                  {e.message}
                </div>
              );
            case "context":
              return null; // merged into the card at the top
            case "info":
              return (
                <div key={seq} className="muted small">
                  {e.message}
                </div>
              );
            default:
              return null;
          }
  };


  useLayoutEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [events, stream]);
  useEffect(() => {
    stick.current = true;
  }, []);

  return (
    <div
      className="transcript"
      ref={ref}
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      }}
    >
      <div className="transcript-inner">
        {ctx && <ContextCard ctx={ctx} />}
        {items.map((it) =>
          it.kind === "group" ? (
            <ToolGroup key={it.rows[0].seq} rows={it.rows} results={results} live={status !== "idle" && it === items[items.length - 1]} render={renderRow} />
          ) : (
            renderRow(it.row)
          ),
        )}
        {stream.thinking && (
          <details className="thinking live" open>
            <summary>Thinking…</summary>
            <div className="thinking-text">{stream.thinking}</div>
          </details>
        )}
        {stream.text && (
          <div className="msg assistant live">
            <Markdown text={stream.text} />
          </div>
        )}
        {status !== "idle" && <Working since={turnStart} quiet={!!stream.text} />}
        {background.length > 0 && (
          <div className="bg-agents">
            <span className="spinner" />
            <span>
              {background.length} background agent{background.length === 1 ? "" : "s"} working
              {status === "idle" ? ". Claude picks up again when they finish." : ""}
            </span>
            <span className="muted small">{background.map((t) => t.description).join(" · ")}</span>
          </div>
        )}
        {events.length === 0 && <div className="empty muted">Tell Claude what you want to do in this project.</div>}
      </div>
    </div>
  );
}
