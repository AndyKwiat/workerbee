import { useEffect, useState } from "react";
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

function Plus() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

const MIN_W = 200;
const MAX_W = 600;
const DEFAULT_W = 280;

/** Desktop sidebar width: a drag handle on its right edge, remembered per browser. Double-click resets. */
function useSidebarWidth() {
  const [w, setW] = useState(() => {
    try {
      const n = Number(localStorage.getItem("wb.sidebarWidth"));
      return n >= MIN_W && n <= MAX_W ? n : DEFAULT_W;
    } catch {
      return DEFAULT_W;
    }
  });
  useEffect(() => {
    document.documentElement.style.setProperty("--sidebar-w", `${w}px`);
  }, [w]);
  const save = (n: number) => {
    try {
      localStorage.setItem("wb.sidebarWidth", String(n));
    } catch {}
  };
  const onPointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = w;
    let last = w;
    document.body.classList.add("resizing");
    const move = (ev: PointerEvent) => {
      last = Math.min(MAX_W, Math.max(MIN_W, startW + ev.clientX - startX));
      setW(last);
    };
    const up = () => {
      document.body.classList.remove("resizing");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      save(last);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  const reset = () => (setW(DEFAULT_W), save(DEFAULT_W));
  return { onPointerDown, reset };
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
  onNewSession: (project: string, folderId?: string | null) => void;
  onNewProject: () => void;
  onAccount: () => void;
  onDelete: (s: Session) => void;
  onArchive: (s: Session) => void;
  onRename: (s: Session) => void;
  onMove: (s: Session, folderId: string | null) => void;
  onNewFolder: (project: string) => void;
  onRenameFolder: (f: Folder) => void;
  onDeleteFolder: (f: Folder) => void;
  onReorderFolders: (project: string, ids: string[]) => void;
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
  const resize = useSidebarWidth();
  const [hideEmpty, setHideEmpty] = useStoredFlag("wb.hideEmptyProjects");

  const visible = p.state.sessions.filter((s) => !!s.archived === showArchived);
  const folders = p.state.folders ?? [];
  const foldersOf = (project: string) =>
    folders.filter((f) => f.project === project).sort((a, b) => a.position - b.position || a.created_at.localeCompare(b.created_at));

  // Drag a folder onto another one in the same project to reorder (a line shows where it lands).
  const [dragFolder, setDragFolder] = useState<Folder | null>(null);
  const [slot, setSlot] = useState<{ id: string; after: boolean } | null>(null);
  const moveFolder = (f: Folder, targetId: string, after: boolean) => {
    const ids = foldersOf(f.project).map((x) => x.id).filter((id) => id !== f.id);
    const at = ids.indexOf(targetId);
    if (at < 0) return;
    ids.splice(after ? at + 1 : at, 0, f.id);
    const before = foldersOf(f.project).map((x) => x.id);
    if (ids.join() !== before.join()) p.onReorderFolders(f.project, ids);
  };
  const nudgeFolder = (f: Folder, by: -1 | 1) => {
    const ids = foldersOf(f.project).map((x) => x.id);
    const i = ids.indexOf(f.id);
    const j = i + by;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    p.onReorderFolders(f.project, ids);
  };
  /** Drop handlers for a folder block: folder drags reorder, session drags move the session in. */
  const folderZone = (f: Folder) => {
    const sessions = dropZone(f.project, f.id);
    const where = (e: React.DragEvent) => {
      const row = (e.currentTarget as HTMLElement).querySelector(".folder-row")!.getBoundingClientRect();
      return e.clientY > row.top + row.height / 2;
    };
    return {
      onDragOver: (e: React.DragEvent) => {
        if (!dragFolder) return sessions.onDragOver(e);
        if (dragFolder.project !== f.project) return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = "move";
        const after = where(e);
        if (slot?.id !== f.id || slot.after !== after) setSlot({ id: f.id, after });
      },
      onDrop: (e: React.DragEvent) => {
        if (!dragFolder) return sessions.onDrop(e);
        if (dragFolder.project !== f.project) return;
        e.preventDefault();
        e.stopPropagation();
        if (dragFolder.id !== f.id) moveFolder(dragFolder, f.id, where(e));
        setDragFolder(null);
        setSlot(null);
      },
    };
  };

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
      <div className="sidebar-resizer hide-mobile" onPointerDown={resize.onPointerDown} onDoubleClick={resize.reset} title="Drag to resize (double-click to reset)" />
      <div className="sidebar-actions">
        {grouped ? (
          <div className="sidebar-head">
            <span className="muted small">Projects</span>
            <button className="small-btn" onClick={p.onNewProject}>
              + Project
            </button>
          </div>
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
            <button className="small-btn" onClick={p.onNewProject}>
              + Project
            </button>
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
      <div className="projects" onDragOver={() => (over && setOver(null), slot && setSlot(null))}>
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
                    <button className="icon folder-add" title={`New folder in ${name}`} aria-label={`New folder in ${name}`} onClick={() => p.onNewFolder(name)}>
                      <FolderPlus />
                    </button>
                    <button className="new-session" title={`New session in ${name}`} aria-label={`New session in ${name}`} onClick={() => p.onNewSession(name)}>
                      <Plus />
                    </button>
                  </div>
                  {open &&
                    fs.map((f, fi) => {
                      const inside = list.filter((s) => s.folder_id === f.id);
                      if (showArchived && !inside.length) return null;
                      const key = `folder:${f.id}`;
                      const fOpen = !collapsed[key];
                      return (
                        <div
                          key={f.id}
                          className={[
                            "folder",
                            over === f.id ? "drop" : "",
                            dragFolder?.id === f.id ? "dragging" : "",
                            slot?.id === f.id && dragFolder?.id !== f.id ? (slot.after ? "slot-after" : "slot-before") : "",
                          ].join(" ")}
                          {...folderZone(f)}
                        >
                          <div
                            className="folder-row"
                            draggable
                            onDragStart={(e) => {
                              e.stopPropagation();
                              e.dataTransfer.setData("text/plain", f.name);
                              e.dataTransfer.effectAllowed = "move";
                              setDragFolder(f);
                              setMenu(null);
                            }}
                            onDragEnd={() => (setDragFolder(null), setSlot(null))}
                          >
                            <button className="folder-name" onClick={() => toggle(key)} title={f.name}>
                              <span className="caret">{fOpen ? "▾" : "▸"}</span>
                              {!fOpen && inside.some(busy) ? <span className="spinner" aria-label="Working" /> : <span className="folder-icon">📁</span>}
                              <span className="folder-label">{f.name}</span>
                              {!fOpen && <span className="folder-count">{inside.length}</span>}
                            </button>
                            {!fOpen && <StatusTag list={inside} />}
                            <button
                              className="new-session"
                              title={`New session in ${f.name}`}
                              aria-label={`New session in ${f.name}`}
                              onClick={() => p.onNewSession(name, f.id)}
                            >
                              <Plus />
                            </button>
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
                                {fi > 0 && <button onClick={() => (setMenu(null), nudgeFolder(f, -1))}>Move up</button>}
                                {fi < fs.length - 1 && <button onClick={() => (setMenu(null), nudgeFolder(f, 1))}>Move down</button>}
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
