import { useState } from "react";
import type { AuthStatus, Folder, Session, State } from "./api";

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

const when = (s: Session) => s.last_activity ?? s.created_at;
const newestFirst = (list: Session[]) => [...list].sort((a, b) => when(b).localeCompare(when(a)));
const busy = (s: Session) => s.status === "running" || (s.status === "idle" && !!s.background?.length);

/** The right-hand tag of a row: what needs attention first, else how long ago something happened. */
function StatusTag({ list }: { list: Session[] }) {
  if (list.some((s) => s.status === "waiting")) return <span className="small status-tag waiting">needs you</span>;
  if (list.some((s) => s.status === "running")) return <span className="small status-tag running">working</span>;
  const tasks = list.flatMap((s) => s.background ?? []);
  if (tasks.length)
    return (
      <span className="small status-tag running" title={tasks.map((t) => t.description).join("\n")}>
        {tasks.length} agent{tasks.length === 1 ? "" : "s"}
      </span>
    );
  if (!list.length) return null;
  return <span className="muted small">{ago(when(newestFirst(list)[0]))}</span>;
}

function FolderPlus() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      <path d="M12 11v5M9.5 13.5h5" />
    </svg>
  );
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
  onMove: (s: Session, folderId: string | null) => void;
  onNewFolder: (project: string) => void;
  onRenameFolder: (f: Folder) => void;
  onDeleteFolder: (f: Folder) => void;
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
  const folders = p.state.folders ?? [];
  const foldersOf = (project: string) => folders.filter((f) => f.project === project);

  // Drag a session onto a folder (or the project, for its root). Only within the same project.
  const [drag, setDrag] = useState<Session | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const dropZone = (project: string, folderId: string | null) => {
    const key = folderId ?? `root:${project}`;
    const ok = () => !!drag && drag.project === project;
    return {
      onDragOver: (e: React.DragEvent) => {
        if (!ok()) return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = "move";
        if (over !== key) setOver(key);
      },
      onDrop: (e: React.DragEvent) => {
        if (!ok()) return;
        e.preventDefault();
        e.stopPropagation();
        if ((drag!.folder_id ?? null) !== folderId) p.onMove(drag!, folderId);
        setDrag(null);
        setOver(null);
      },
    };
  };

  const byProject = new Map<string, Session[]>();
  for (const s of visible) byProject.set(s.project, [...(byProject.get(s.project) ?? []), s]);
  const names = new Set([...p.state.projects.map((x) => x.name), ...byProject.keys()]);

  const row = (s: Session, showProject: boolean) => (
    <div
      key={s.id}
      className={`session-row ${p.current === s.id ? "active" : ""} ${drag?.id === s.id ? "dragging" : ""}`}
      draggable={grouped}
      onDragStart={(e) => {
        e.dataTransfer.setData("text/plain", s.title || s.id);
        e.dataTransfer.effectAllowed = "move";
        setDrag(s);
        setMenu(null);
      }}
      onDragEnd={() => (setDrag(null), setOver(null))}
    >
      <a href={`#/s/${s.id}`} className={`session-link ${showProject ? "flat" : ""}`} title={tip(s)} draggable={false}>
        {busy(s) ? (
          <span className="spinner" aria-label="Working" />
        ) : (
          <span className={`dot ${s.status}`} />
        )}
        <span className="session-text">
          <span className="session-title">{s.title || "New session"}</span>
          {showProject && <span className="session-project">{s.project}</span>}
        </span>
        <StatusTag list={[s]} />
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
      {menu === `move:${s.id}` && (
        <div className="menu" onClick={(e) => e.stopPropagation()}>
          <button disabled={!s.folder_id} onClick={() => (setMenu(null), p.onMove(s, null))}>
            {s.project} (no folder)
          </button>
          {foldersOf(s.project).map((f) => (
            <button key={f.id} disabled={s.folder_id === f.id} onClick={() => (setMenu(null), p.onMove(s, f.id))}>
              📁 {f.name}
            </button>
          ))}
        </div>
      )}
      {menu === s.id && (
        <div className="menu" onClick={(e) => e.stopPropagation()}>
          <button onClick={() => (setMenu(null), p.onRename(s))}>Rename</button>
          {foldersOf(s.project).length > 0 && (
            <button onClick={() => setMenu(`move:${s.id}`)}>Move to…</button>
          )}
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
      <div className="projects" onDragOver={() => over && setOver(null)}>
        {grouped
          ? [...names].sort().map((name) => {
              const list = byProject.get(name) ?? [];
              if ((showArchived || hideEmpty) && !list.length) return null;
              const open = !collapsed[name];
              const fs = foldersOf(name);
              const ids = new Set(fs.map((f) => f.id));
              const root = list.filter((s) => !s.folder_id || !ids.has(s.folder_id));
              return (
                <div key={name} className={`project ${over === `root:${name}` ? "drop" : ""}`} {...dropZone(name, null)}>
                  <div className="project-row">
                    <button className="project-name" onClick={() => toggle(name)}>
                      <span className="caret">{open ? "▾" : "▸"}</span> {name}
                    </button>
                    <button className="icon" title={`New folder in ${name}`} onClick={() => p.onNewFolder(name)}>
                      <FolderPlus />
                    </button>
                    <button className="icon" title={`New session in ${name}`} onClick={() => p.onNewSession(name)}>
                      ＋
                    </button>
                  </div>
                  {open &&
                    fs.map((f) => {
                      const inside = list.filter((s) => s.folder_id === f.id);
                      if (showArchived && !inside.length) return null;
                      const key = `folder:${f.id}`;
                      const fOpen = !collapsed[key];
                      return (
                        <div key={f.id} className={`folder ${over === f.id ? "drop" : ""}`} {...dropZone(name, f.id)}>
                          <div className="folder-row">
                            <button className="folder-name" onClick={() => toggle(key)} title={f.name}>
                              <span className="caret">{fOpen ? "▾" : "▸"}</span>
                              {!fOpen && inside.some(busy) ? <span className="spinner" aria-label="Working" /> : <span className="folder-icon">📁</span>}
                              <span className="folder-label">{f.name}</span>
                              {!fOpen && <span className="folder-count">{inside.length}</span>}
                            </button>
                            {!fOpen && <StatusTag list={inside} />}
                            <button
                              className="icon more"
                              onClick={(e) => {
                                e.stopPropagation();
                                setMenu(menu === key ? null : key);
                              }}
                            >
                              ⋯
                            </button>
                            {menu === key && (
                              <div className="menu" onClick={(e) => e.stopPropagation()}>
                                <button onClick={() => (setMenu(null), p.onRenameFolder(f))}>Rename</button>
                                <button className="danger" onClick={() => (setMenu(null), p.onDeleteFolder(f))}>
                                  Delete
                                </button>
                              </div>
                            )}
                          </div>
                          {fOpen && (
                            <div className="folder-sessions">
                              {newestFirst(inside).map((s) => row(s, false))}
                              {!inside.length && <div className="folder-empty muted small">Drag sessions here</div>}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  {open && newestFirst(root).map((s) => row(s, false))}
                </div>
              );
            })
          : newestFirst(visible).map((s) => row(s, true))}
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
