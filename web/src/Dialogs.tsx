import { useEffect, useState } from "react";
import { api, type AuthStatus } from "./api";

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  useEffect(() => {
    const f = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", f);
    return () => window.removeEventListener("keydown", f);
  }, [onClose]);
  return (
    <div className="modal-scrim" onMouseDown={onClose}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <b>{title}</b>
          <button className="icon" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function NewProjectDialog({ onClose, onCreate }: { onClose: () => void; onCreate: (name: string, git: string) => Promise<void> }) {
  const [name, setName] = useState("");
  const [git, setGit] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fromGit = (url: string) => {
    setGit(url);
    const m = url.match(/([\w.-]+?)(\.git)?\/?$/);
    if (m && !name) setName(m[1]);
  };
  return (
    <Modal title="New project" onClose={onClose}>
      <form
        className="form"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setErr(null);
          try {
            await onCreate(name.trim(), git.trim());
          } catch (e: any) {
            setErr(e?.message ?? String(e));
            setBusy(false);
          }
        }}
      >
        <label>
          Git URL <span className="muted small">(optional: clone instead of an empty folder)</span>
          <input value={git} onChange={(e) => fromGit(e.target.value)} placeholder="https://github.com/you/repo.git" />
        </label>
        <label>
          Folder name
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="my-project" autoFocus pattern="[A-Za-z0-9][A-Za-z0-9._-]*" required />
        </label>
        {err && <div className="err small">{err}</div>}
        <div className="row-end">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="primary" disabled={busy || !name.trim()}>
            {busy ? (git ? "Cloning…" : "Creating…") : "Create"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function AccountDialog({
  harness,
  auth,
  setAuth,
  onClose,
}: {
  harness: string;
  auth: AuthStatus | null;
  setAuth: (a: AuthStatus) => void;
  onClose: () => void;
}) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [version, setVersion] = useState("");

  useEffect(() => {
    api.auth(harness).then(setAuth).catch(() => {});
    api.version(harness).then((v) => setVersion(v.version)).catch(() => {});
  }, [harness, setAuth]);

  const run = async (label: string, f: () => Promise<AuthStatus>) => {
    setBusy(label);
    setMsg(null);
    try {
      const a = await f();
      setAuth(a);
      if (a.detail) setMsg(a.detail);
    } catch (e: any) {
      setMsg(e?.message ?? String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Modal title="Claude account on the server" onClose={onClose}>
      <div className="form">
        <div>
          Status:{" "}
          {auth ? (
            auth.loggedIn ? (
              <b className="ok">Logged in{auth.email ? ` as ${auth.email}` : ""}</b>
            ) : (
              <b className="err">Not logged in</b>
            )
          ) : (
            "…"
          )}
          {auth?.method && <span className="muted small"> ({auth.method})</span>}
        </div>
        {auth?.expiresAt && <div className="muted small">Login expires {new Date(auth.expiresAt).toLocaleString()}</div>}

        {auth?.pendingLoginUrl ? (
          <div className="login-steps">
            <div>
              1.{" "}
              <a href={auth.pendingLoginUrl} target="_blank" rel="noreferrer">
                Open the Claude sign-in page ↗
              </a>{" "}
              and approve.
            </div>
            <div>2. Copy the code it shows and paste it here:</div>
            <form
              className="row"
              onSubmit={(e) => {
                e.preventDefault();
                run("code", () => api.code(harness, code)).then(() => setCode(""));
              }}
            >
              <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="Paste code" autoFocus />
              <button className="primary" disabled={!code.trim() || !!busy}>
                {busy === "code" ? "Signing in…" : "Submit"}
              </button>
            </form>
          </div>
        ) : (
          <div className="row">
            <button className="primary" disabled={!!busy} onClick={() => run("login", () => api.login(harness))}>
              {busy === "login" ? "Starting…" : auth?.loggedIn ? "Log in again" : "Log in with Claude"}
            </button>
            {auth?.loggedIn && (
              <button disabled={!!busy} onClick={() => confirm("Log out Claude on the server?") && run("logout", () => api.logout(harness))}>
                Log out
              </button>
            )}
          </div>
        )}
        {msg && <div className="small muted pre">{msg}</div>}
        <hr />
        <div className="row">
          <span className="muted small">CLI {version || "…"}</span>
          <span className="spacer" />
          <button
            disabled={!!busy}
            onClick={async () => {
              setBusy("update");
              try {
                const r = await api.update(harness);
                setMsg(r.output);
                setVersion((await api.version(harness)).version);
              } catch (e: any) {
                setMsg(e?.message);
              } finally {
                setBusy(null);
              }
            }}
          >
            {busy === "update" ? "Updating…" : "Update Claude Code"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
