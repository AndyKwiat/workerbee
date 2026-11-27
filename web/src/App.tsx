import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, connect, type AuthStatus, type EventRow, type ModelOption, type Push, type Session, type State, type TaskProgress } from "./api";
import { Sidebar } from "./Sidebar";
import { UsageBar } from "./UsageBar";
import { Transcript } from "./Transcript";
import { Composer } from "./Composer";
import { useTabStatus } from "./tabStatus";
import { ContextMeter, latestContextUsage } from "./ContextMeter";
import { AccountDialog, NewProjectDialog } from "./Dialogs";

type Stream = { text: string; thinking: string };

function hashSession() {
  const m = location.hash.match(/^#\/s\/([\w-]+)/);
  return m ? m[1] : null;
}

export function App() {
  const [state, setState] = useState<State | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [current, setCurrent] = useState<string | null>(hashSession());
  const [editingTitle, setEditingTitle] = useState(false);
  const renameNext = useRef<string | null>(null); // sidebar "Rename" on another session: edit once it's open
  const [events, setEvents] = useState<EventRow[]>([]);
  const [stream, setStream] = useState<Stream>({ text: "", thinking: "" });
  const [progress, setProgress] = useState<Record<string, TaskProgress>>({}); // live subagent progress, by task_id
  const [auth, setAuth] = useState<AuthStatus | null>(null);
  const [connected, setConnected] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [dialog, setDialog] = useState<"account" | "project" | null>(null);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [toast, setToast] = useState<string | null>(null);
  const currentRef = useRef(current);
  currentRef.current = current;

  const harness = state?.defaultHarness ?? "claude";

  const flash = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast((t) => (t === msg ? null : t)), 5000);
  }, []);
  const guard = useCallback(
    async <T,>(p: Promise<T>) => {
      try {
        return await p;
      } catch (e: any) {
        flash(e?.message ?? String(e));
        return undefined;
      }
    },
    [flash],
  );

  const loadState = useCallback(async () => {
    try {
      setState(await api.state());
      setLoadErr(null);
    } catch (e: any) {
      setLoadErr(e?.message ?? String(e));
    }
  }, []);

  const loadEvents = useCallback(async (id: string | null) => {
    setStream({ text: "", thinking: "" });
    setProgress({});
    if (!id) return setEvents([]);
    try {
      const ev = await api.events(id);
      if (currentRef.current === id) setEvents(ev);
    } catch {}
  }, []);

  const onPush = useCallback((m: Push) => {
    switch (m.type) {
      case "event":
        if (m.session_id !== currentRef.current) break;
        setEvents((ev) => (ev.length && ev[ev.length - 1].seq >= m.seq ? ev : [...ev, m]));
        if (m.event.type === "text" || m.event.type === "turn_end") setStream((s) => ({ ...s, text: "" }));
        if (m.event.type === "thinking" || m.event.type === "turn_end") setStream((s) => ({ ...s, thinking: "" }));
        break;
      case "delta":
        if (m.session_id !== currentRef.current) break;
        if (m.delta.kind === "task") {
          const { kind: _, ...p } = m.delta;
          setProgress((cur) => ({ ...cur, [p.task_id]: p }));
        } else {
          const d = m.delta;
          setStream((s) => ({ ...s, [d.kind]: s[d.kind] + d.text }));
        }
        break;
      case "session":
        setState((st) => {
          if (!st) return st;
          const rest = st.sessions.filter((s) => s.id !== m.session.id);
          return { ...st, sessions: [m.session, ...rest].sort((a, b) => b.updated_at.localeCompare(a.updated_at)) };
        });
        break;
      case "session_deleted":
        setState((st) => (st ? { ...st, sessions: st.sessions.filter((s) => s.id !== m.id) } : st));
        if (currentRef.current === m.id) location.hash = "";
        break;
      case "usage":
        setState((st) => (st ? { ...st, usage: { ...st.usage, [m.harness]: m.usage } } : st));
        break;
      case "auth":
        setAuth(m.auth);
        break;
      case "folders":
        setState((st) => (st ? { ...st, folders: m.folders } : st));
        break;
      case "projects":
        api.projects().then((projects) => setState((st) => (st ? { ...st, projects } : st)));
        break;
    }
  }, []);

  useEffect(() => {
    const stop = connect(
      onPush,
      () => {
        loadState();
        loadEvents(currentRef.current);
      },
      setConnected,
    );
    return stop;
  }, [onPush, loadState, loadEvents]);

  // On page load, drop sessions that were created but never used (untitled, nothing sent).
  useEffect(() => {
    api
      .cleanupSessions()
      .then(({ deleted }) => {
        if (!deleted.length) return;
        setState((st) => (st ? { ...st, sessions: st.sessions.filter((s) => !deleted.includes(s.id)) } : st));
        if (currentRef.current && deleted.includes(currentRef.current)) location.hash = "";
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    const f = () => {
      const id = hashSession();
      setCurrent(id);
      setEditingTitle(!!id && renameNext.current === id);
      renameNext.current = null;
      setSidebarOpen(false);
    };
    window.addEventListener("hashchange", f);
    return () => window.removeEventListener("hashchange", f);
  }, []);

  useEffect(() => {
    loadEvents(current);
  }, [current, loadEvents]);

  useEffect(() => {
    api.auth(harness).then(setAuth).catch(() => {});
    api.models(harness).then(setModels).catch(() => {});
  }, [harness]);

  const session: Session | undefined = useMemo(() => state?.sessions.find((s) => s.id === current), [state, current]);
  useTabStatus(state?.sessions, session);
  const ctxUsage = useMemo(() => latestContextUsage(events), [events]);

  const newSession = async (project: string, folderId: string | null = null) => {
    const last = state?.sessions.find((s) => s.project === project) ?? state?.sessions[0];
    const s = await guard(
      api.createSession({
        project,
        folder_id: folderId,
        model: last?.model ?? null,
        effort: last?.effort ?? null,
        permission_mode: last?.permission_mode ?? "default",
      }),
    );
    if (s) location.hash = `#/s/${s.id}`;
  };

  if (!state)
    return (
      <div className="boot">
        <div>🐝 workerbee</div>
        <div className="muted">{loadErr ?? "Loading…"}</div>
      </div>
    );

  return (
    <div className={`app ${sidebarOpen ? "sidebar-open" : ""}`}>
      <header className="topbar">
        <button className="icon only-mobile" onClick={() => setSidebarOpen((o) => !o)} aria-label="Menu">
          ☰
        </button>
        <div className="brand">🐝 workerbee</div>
        <UsageBar usage={state.usage[harness]} onRefresh={() => guard(api.refreshUsage(harness))} />
        <span className={`conn ${connected ? "up" : "down"}`} title={connected ? "Connected" : "Reconnecting…"} />
      </header>
      <Sidebar
        state={state}
        current={current}
        auth={auth}
        onNewSession={newSession}
        onNewProject={() => setDialog("project")}
        onAccount={() => setDialog("account")}
        onDelete={async (s) => {
          if (confirm(`Delete session "${s.title || "Untitled"}"? Project files are kept.`)) await guard(api.deleteSession(s.id));
        }}
        onArchive={(s) => guard(api.updateSession(s.id, { archived: !s.archived }))}
        onMove={(s, folderId) => guard(api.updateSession(s.id, { folder_id: folderId }))}
        onNewFolder={(project) => {
          const name = prompt(`New folder in ${project}:`)?.trim();
          if (name) guard(api.createFolder(project, name));
        }}
        onRenameFolder={(f) => {
          const name = prompt("Rename folder:", f.name)?.trim();
          if (name && name !== f.name) guard(api.renameFolder(f.id, name));
        }}
        onReorderFolders={(project, ids) => {
          // Show the new order right away; the server's push confirms it.
          setState((st) => {
            if (!st) return st;
            const pos = new Map(ids.map((id, i) => [id, i]));
            return { ...st, folders: st.folders.map((f) => (f.project === project && pos.has(f.id) ? { ...f, position: pos.get(f.id)! } : f)) };
          });
          guard(api.reorderFolders(project, ids));
        }}
        onDeleteFolder={(f) => {
          if (confirm(`Delete folder "${f.name}"? Its sessions move back to the project.`)) guard(api.deleteFolder(f.id));
        }}
        onRename={(s) => {
          // Open the session and edit its title in the header.
          renameNext.current = s.id;
          setSidebarOpen(false);
          if (currentRef.current === s.id) setEditingTitle(true);
          else location.hash = `#/s/${s.id}`;
        }}
      />
      <div className="scrim only-mobile" onClick={() => setSidebarOpen(false)} />
      <main className="main">
        {session ? (
          <>
            <div className="session-head">
              <EditableTitle
                key={session.id}
                title={session.title}
                editing={editingTitle}
                setEditing={setEditingTitle}
                onSave={(t) => guard(api.updateSession(session.id, { title: t }))}
              />
              <div className="muted small">
                {session.project} · {session.harness}
                {session.harness_session_id ? ` · ${session.harness_session_id.slice(0, 8)}` : ""}
                {ctxUsage && <ContextMeter key={session.id} data={ctxUsage} />}
              </div>
            </div>
            <Transcript
              events={events}
              stream={stream}
              status={session.status}
              progress={progress}
              background={session.background ?? []}
              onStopTask={(taskId) => guard(api.stopTask(session.id, taskId))}
              onAnswer={(rid, d, extra) => guard(api.answer(rid, d, extra))}
            />
            <Composer
              key={session.id}
              session={session}
              models={models}
              onSend={(text, images) => guard(api.send(session.id, text, images))}
              onStop={() => guard(api.interrupt(session.id))}
              onChange={(p) => guard(api.updateSession(session.id, p))}
            />
          </>
        ) : (
          <Welcome state={state} auth={auth} onNewProject={() => setDialog("project")} onNewSession={newSession} onAccount={() => setDialog("account")} />
        )}
      </main>
      {dialog === "account" && <AccountDialog harness={harness} auth={auth} setAuth={setAuth} onClose={() => setDialog(null)} />}
      {dialog === "project" && (
        <NewProjectDialog
          onClose={() => setDialog(null)}
          onCreate={async (name, git) => {
            const p = await api.createProject(name, git || undefined);
            setDialog(null);
            await newSession(p.name);
          }}
        />
      )}
      {toast && <div className="toast" onClick={() => setToast(null)}>{toast}</div>}
    </div>
  );
}

/** The session title in the header: click it (or the pencil) to rename; Enter or leaving the field saves, Esc cancels. */
function EditableTitle(p: { title: string; editing: boolean; setEditing: (v: boolean) => void; onSave: (t: string) => void }) {
  const [draft, setDraft] = useState(p.title);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!p.editing) return;
    setDraft(p.title);
    // After the composer's own focus-on-open, so the title keeps the cursor.
    const t = setTimeout(() => {
      input.current?.focus();
      input.current?.select();
    }, 50);
    return () => clearTimeout(t);
  }, [p.editing]);
  const done = (save: boolean) => {
    if (!p.editing) return;
    p.setEditing(false);
    const t = draft.trim().replace(/\s+/g, " ");
    if (save && t !== p.title) p.onSave(t);
  };
  if (p.editing)
    return (
      <input
        ref={input}
        className="title-input"
        value={draft}
        maxLength={200}
        placeholder="Session title"
        aria-label="Session title"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => done(true)}
        onKeyDown={(e) => {
          if (e.key === "Enter") done(true);
          if (e.key === "Escape") done(false);
        }}
      />
    );
  return (
    <div className="title-row">
      <button className="title" title="Rename" onClick={() => p.setEditing(true)}>
        {p.title || "New session"}
      </button>
      <button className="icon rename" aria-label="Rename session" title="Rename" onClick={() => p.setEditing(true)}>
        ✎
      </button>
    </div>
  );
}

function agoLong(iso: string) {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  const unit = (n: number, u: string) => `${n} ${u}${n === 1 ? "" : "s"} ago`;
  if (s < 60) return "just now";
  if (s < 3600) return unit(Math.floor(s / 60), "minute");
  if (s < 86400) return unit(Math.floor(s / 3600), "hour");
  return unit(Math.floor(s / 86400), "day");
}

/** The 20 sessions most recently talked in (a message sent or an answer received). */
function Recent(p: { sessions: Session[] }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);
  const list = p.sessions
    .filter((s) => s.last_activity && !s.archived)
    .sort((a, b) => b.last_activity!.localeCompare(a.last_activity!))
    .slice(0, 20);
  if (!list.length) return null;
  return (
    <>
      <p className="muted">Recent sessions:</p>
      <div className="recent">
        {list.map((s) => (
          <a key={s.id} className="recent-row" href={`#/s/${s.id}`}>
            <span className="recent-title">
              {s.status !== "idle" ? <span className={`dot ${s.status}`} /> : s.background?.length ? <span className="dot running" /> : null}
              {s.title || "Untitled"}
            </span>
            <span className="muted small recent-project">{s.project}</span>
            <span className="muted small recent-when" title={new Date(s.last_activity!).toLocaleString()}>
              {agoLong(s.last_activity!)}
            </span>
          </a>
        ))}
      </div>
    </>
  );
}

function Welcome(p: { state: State; auth: AuthStatus | null; onNewProject: () => void; onNewSession: (project: string) => void; onAccount: () => void }) {
  return (
    <div className="welcome">
      <h1>🐝 workerbee</h1>
      {p.auth && !p.auth.loggedIn && (
        <div className="card warn">
          Claude isn't logged in on the server. <button onClick={p.onAccount}>Log in</button>
        </div>
      )}
      {p.state.projects.length === 0 ? (
        <p>
          Create a project (a folder on the server) to start. <button onClick={p.onNewProject}>New project</button>
        </p>
      ) : (
        <>
          <Recent sessions={p.state.sessions} />
          <p className="muted">Start a session in a project:</p>
          <div className="project-grid">
            {p.state.projects.map((pr) => (
              <button key={pr.name} className="project-tile" onClick={() => p.onNewSession(pr.name)}>
                <b>{pr.name}</b>
                <span className="muted small">{pr.git ? "git" : "folder"}</span>
              </button>
            ))}
            <button className="project-tile ghost" onClick={p.onNewProject}>
              + New project
            </button>
          </div>
        </>
      )}
    </div>
  );
}
