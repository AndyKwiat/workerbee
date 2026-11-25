import { useEffect, useRef, useState } from "react";
import type { ModelOption, PermissionMode, Session } from "./api";

const MODES: { value: PermissionMode; label: string }[] = [
  { value: "default", label: "Ask permissions" },
  { value: "acceptEdits", label: "Accept edits" },
  { value: "plan", label: "Plan mode" },
  { value: "auto", label: "Auto" },
  { value: "bypassPermissions", label: "Bypass permissions" },
];
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];

type Img = { mediaType: string; data: string; url: string };

function readImage(f: File): Promise<Img> {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => {
      const url = String(r.result);
      res({ mediaType: f.type, data: url.split(",")[1], url });
    };
    r.onerror = rej;
    r.readAsDataURL(f);
  });
}

export function Composer(p: {
  session: Session;
  models: ModelOption[];
  onSend: (text: string, images?: { mediaType: string; data: string }[]) => Promise<unknown>;
  onStop: () => void;
  onChange: (patch: { model?: string | null; effort?: string | null; permission_mode?: PermissionMode }) => void;
}) {
  const draftKey = `wb.draft.${p.session.id}`;
  const [text, setText] = useState(() => {
    try {
      return localStorage.getItem(draftKey) ?? "";
    } catch {
      return "";
    }
  });
  const [images, setImages] = useState<Img[]>([]);
  const ta = useRef<HTMLTextAreaElement>(null);
  const busy = p.session.status !== "idle";

  useEffect(() => {
    try {
      text ? localStorage.setItem(draftKey, text) : localStorage.removeItem(draftKey);
    } catch {}
  }, [text, draftKey]);

  useEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, window.innerHeight * 0.4) + "px";
  }, [text]);

  useEffect(() => {
    if (window.matchMedia("(pointer: fine)").matches) ta.current?.focus();
  }, []);

  const send = async () => {
    if (!text.trim() && !images.length) return;
    const t = text;
    const imgs = images.map(({ mediaType, data }) => ({ mediaType, data }));
    setText("");
    setImages([]);
    const ok = await p.onSend(t, imgs.length ? imgs : undefined);
    if (ok === undefined) setText(t); // failed: put it back
  };

  const addFiles = async (files: FileList | File[]) => {
    const imgs = await Promise.all([...files].filter((f) => f.type.startsWith("image/")).map(readImage));
    if (imgs.length) setImages((cur) => [...cur, ...imgs].slice(0, 8));
  };

  const model = p.session.model ?? "";
  const efforts = p.models.find((m) => m.value === model)?.efforts ?? EFFORTS;

  return (
    <div className="composer">
      {images.length > 0 && (
        <div className="thumbs">
          {images.map((im, i) => (
            <button key={i} className="thumb" onClick={() => setImages((c) => c.filter((_, j) => j !== i))} title="Remove">
              <img src={im.url} alt="" />
            </button>
          ))}
        </div>
      )}
      <div className="composer-box">
        <textarea
          ref={ta}
          rows={1}
          value={text}
          placeholder={busy ? "Claude is working… (your message will be queued)" : "Message Claude…"}
          onChange={(e) => setText(e.target.value)}
          onPaste={(e) => {
            const files = [...e.clipboardData.files];
            if (files.length) {
              e.preventDefault();
              addFiles(files);
            }
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && window.matchMedia("(pointer: fine)").matches) {
              e.preventDefault();
              send();
            }
          }}
        />
        <div className="composer-bar">
          <label className="icon attach" title="Attach image">
            📎
            <input type="file" accept="image/*" multiple hidden onChange={(e) => e.target.files && addFiles(e.target.files)} />
          </label>
          <select value={model} onChange={(e) => p.onChange({ model: e.target.value || null })} title="Model">
            <option value="">Default model</option>
            {p.models
              .filter((m) => m.value !== "default")
              .map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
          </select>
          <select value={p.session.effort ?? ""} onChange={(e) => p.onChange({ effort: e.target.value || null })} title="Effort (applies from the next turn)">
            <option value="">Default effort</option>
            {efforts.map((x) => (
              <option key={x} value={x}>
                {x}
              </option>
            ))}
          </select>
          <select
            value={p.session.permission_mode}
            onChange={(e) => p.onChange({ permission_mode: e.target.value as PermissionMode })}
            title="Permission mode"
            className={p.session.permission_mode === "bypassPermissions" ? "danger" : ""}
          >
            {MODES.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>
          <span className="spacer" />
          {busy && (
            <button className="stop" onClick={p.onStop} title="Stop">
              ■ Stop
            </button>
          )}
          <button className="primary send" onClick={send} disabled={!text.trim() && !images.length}>
            Send
          </button>
        </div>
      </div>
    </div>
  );
}
