import { useEffect, useRef, useState } from "react";
import type { EventRow, WbEvent } from "./api";

export type ContextUsage = Extract<WbEvent, { type: "context_usage" }>;

/** The newest context snapshot in a session's events, with when it was taken. */
export function latestContextUsage(events: EventRow[]): { usage: ContextUsage; ts: string } | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i].event;
    if (e.type === "context_usage") return { usage: e, ts: events[i].ts };
  }
  return null;
}

/** 950, 12.3k, 84k, 1.2M */
export function fmtTokens(n: number) {
  if (n < 1000) return String(Math.round(n));
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0)}M`;
}

export const level = (pct: number) => (pct >= 90 ? "crit" : pct >= 70 ? "warn" : "");

function ago(ts: string) {
  const s = (Date.now() - Date.parse(ts)) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

/** "84k / 200k · 42%" in the session header; click for the per-category breakdown (like /context). */
export function ContextMeter({ data }: { data: { usage: ContextUsage; ts: string } }) {
  const { usage: u, ts } = data;
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, [open]);
  const pct = Math.round(u.percentage);
  const cats = [...u.categories].sort((a, b) => b.tokens - a.tokens);
  return (
    <span className="ctx-meter-wrap" ref={ref}>
      <button className={`ctx-meter ${level(pct)}`} onClick={() => setOpen((o) => !o)} title="Context window: click for the breakdown">
        <span className="uw-meter">
          <span style={{ width: `${Math.min(100, pct)}%` }} />
        </span>
        {fmtTokens(u.tokens)} / {fmtTokens(u.max)} · {pct}%
      </button>
      {open && (
        <div className="ctx-pop">
          <div className="ctx-pop-head">
            <b>Context</b> {u.tokens.toLocaleString()} of {u.max.toLocaleString()} tokens ({pct}%)
          </div>
          <table>
            <tbody>
              {cats.map((c) => (
                <tr key={c.name} className={c.kind}>
                  <td>{c.name}</td>
                  <td className="num">{c.tokens.toLocaleString()}</td>
                  <td className="num muted">{((100 * c.tokens) / u.max).toFixed(1)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="muted small">
            {u.model && <>{u.model} · </>}measured {ago(ts)}
            {" · "}updates after each turn
          </div>
        </div>
      )}
    </span>
  );
}
