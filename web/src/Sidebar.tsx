import { useState } from "react";
import type { AuthStatus, Session, State } from "./api";

function ago(iso: string) {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

/** Tooltip: the full title, the first message if it says more, and the project. */
function tip(s: Session) {
  const title = s.title || "New session";
  const first = s.first_message?.trim().replace(/\s+/g, " ");
  const full = first ? first + (first.length >= 300 ? "…" : "") : "";
  // Auto titles are the start of the first message: show the message alone then, else both.
  const body = !full ? title : full.startsWith(title) ? full : `${title}\n\n${full}`;
  return `${body}\n\n${s.project}`;
}

/** A checkbox setting remembered in localStorage (per browser). */
function useStoredFlag(key: string): [boolean, (v: boolean) => void] {
  const [v, setV] = useState(() => {
    try {
      return localStorage.getItem(key) === "1";
    } catch {
      return false;
    }
  });
  const set = (next: boolean) => {
    setV(next);
    try {
      localStorage.setItem(key, next ? "1" : "0");
    } catch {}
  };
  return [v, set];
}

export function Sidebar(p: {
  state: State;
  current: string | null;
  auth: AuthStatus | null;
  onNewSession: (project: string) => void;
  onNewProject: () => void;
  onAccount: () => void;
  onDelete: (s: Session) => void;
  onArchive: (s: Session) => void;
  onRename: (s: Session) => void;
}) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() => {
    try {
      return JSON.parse(localStorage.getItem("wb.collapsed") ?? "{}");
    } catch {
      return {};
    }
  });
  const [showArchived, setShowArchived] = useState(false);
  const [menu, setMenu] = useState<string | null>(null);

  const toggle = (name: string) => {
    const next = { ...collapsed, [name]: !collapsed[name] };
    setCollapsed(next);
    try {
      localStorage.setItem("wb.collapsed", JSON.stringify(next));
    } catch {}
  };

  const [grouped, setGroup] = useStoredFlag("wb.groupByProject");
  const [hideEmpty, setHideEmpty] = useStoredFlag("wb.hideEmptyProjects");

  const visible = p.state.sessions.filter((s) => !!s.archived === showArchived);
  const when = (s: Session) => s.last_activity ?? s.created_at;

  const byProject = new Map<string, Session[]>();
  for (const s of visible) byProject.set(s.project, [...(byProject.get(s.project) ?? []), s]);
  const names = new Set([...p.state.projects.map((x) => x.name), ...byProject.keys()]);

  const row = (s: Session, showProject: boolean) => (
    <div key={s.id} className={`session-row ${p.current === s.id ? "active" : ""}`}>
      <a href={`#/s/${s.id}`} className={`session-link ${showProject ? "flat" : ""}`} title={tip(s)}>
        {s.status === "running" || (s.status === "idle" && s.background?.length) ? (
          <span className="spinner" aria-label="Working" />
        ) : (
          <span className={`dot ${s.status}`} />
        )}
        <span className="session-text">
          <span className="session-title">{s.title || "New session"}</span>
          {showProject && <span className="session-project">{s.project}</span>}
        </span>
        {s.status === "running" ? (
          <span className="small status-tag running">working</span>
        ) : s.status === "waiting" ? (
          <span className="small status-tag waiting">needs you</span>
        ) : s.background?.length ? (
          <span className="small status-tag running" title={s.background.map((t) => t.description).join("\n")}>
            {s.background.length} agent{s.background.length === 1 ? "" : "s"}
          </span>
        ) : (
          <span className="muted small">{ago(when(s))}</span>
        )}
      </a>
      <button
        className="icon more"
        onClick={(e) => {
          e.stopPropagation();
          setMenu(menu === s.id ? null : s.id);
        }}
      >
        ⋯
      </button>
      {menu === s.id && (
        <div className="menu" onClick={(e) => e.stopPropagation()}>
          <button onClick={() => (setMenu(null), p.onRename(s))}>Rename</button>
          <button onClick={() => (setMenu(null), p.onArchive(s))}>{s.archived ? "Unarchive" : "Archive"}</button>
          <button className="danger" onClick={() => (setMenu(null), p.onDelete(s))}>
            Delete
          </button>
        </div>
      )}
    </div>
  );

  return (
    <nav className="sidebar" onClick={() => setMenu(null)}>
      <div className="sidebar-actions">
        {grouped ? (
          <button className="primary" onClick={p.onNewProject}>
            + New project
          </button>
        ) : (
          <div className="sidebar-buttons">
            <button
              className="primary"
              onClick={(e) => {
                e.stopPropagation();
                setMenu(menu === "#new" ? null : "#new");
              }}
            >
              + New session
            </button>
            <button onClick={p.onNewProject}>+ Project</button>
            {menu === "#new" && (
              <div className="menu new-menu" onClick={(e) => e.stopPropagation()}>
                {[...names].sort().map((name) => (
                  <button key={name} onClick={() => (setMenu(null), p.onNewSession(name))}>
                    {name}
                  </button>
                ))}
                {!names.size && <div className="muted small">Create a project first.</div>}
              </div>
            )}
          </div>
        )}
      </div>
      <div className="projects">
        {grouped
          ? [...names].sort().map((name) => {
              const list = byProject.get(name) ?? [];
              if ((showArchived || hideEmpty) && !list.length) return null;
              const open = !collapsed[name];
              return (
                <div key={name} className="project">
                  <div className="project-row">
                    <button className="project-name" onClick={() => toggle(name)}>
                      <span className="caret">{open ? "▾" : "▸"}</span> {name}
                    </button>
                    <button className="icon" title={`New session in ${name}`} onClick={() => p.onNewSession(name)}>
                      ＋
                    </button>
                  </div>
                  {open && [...list].sort((a, b) => when(b).localeCompare(when(a))).map((s) => row(s, false))}
                </div>
              );
            })
          : [...visible].sort((a, b) => when(b).localeCompare(when(a))).map((s) => row(s, true))}
      </div>
      <div className="sidebar-foot">
        <label className="small muted">
          <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> Archived
        </label>
        <label className="small muted">
          <input type="checkbox" checked={grouped} onChange={(e) => setGroup(e.target.checked)} /> Group by project
        </label>
        {grouped && (
          <label className="small muted sub-option">
            <input type="checkbox" checked={hideEmpty} onChange={(e) => setHideEmpty(e.target.checked)} /> Hide empty
            projects
          </label>
        )}
        <button className="account" onClick={p.onAccount}>
          <span className={`dot ${p.auth?.loggedIn ? "idle" : "error"}`} />
          {p.auth ? (p.auth.loggedIn ? p.auth.email ?? "Claude: logged in" : "Claude: log in") : "Account"}
        </button>
        <div className="muted small">{p.state.me}</div>
      </div>
    </nav>
  );
}
