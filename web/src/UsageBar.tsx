import { useEffect, useState } from "react";
import type { Usage } from "./api";

function resetsIn(iso?: string | null) {
  if (!iso) return "";
  const s = (new Date(iso).getTime() - Date.now()) / 1000;
  if (!isFinite(s)) return "";
  if (s <= 0) return "resetting";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
}

const level = (used: number) => (used >= 90 ? "crit" : used >= 70 ? "warn" : "ok");

export function UsageBar({ usage, onRefresh }: { usage?: Usage; onRefresh: () => void }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);

  if (!usage) return <div className="usage muted small">usage…</div>;
  if (!usage.ok)
    return (
      <button className="usage usage-err" onClick={onRefresh} title={`Usage unavailable: ${usage.error}. Click to retry.`}>
        ✳︎ ? <span className="muted small">{usage.error}</span>
      </button>
    );
  const fetched = new Date(usage.fetched_at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const title = usage.stale ? `As of ${fetched}; latest check failed: ${usage.stale}` : `Updated ${fetched}. Click to refresh.`;
  return (
    <button className={`usage ${usage.stale ? "stale" : ""}`} onClick={onRefresh} title={title}>
      {usage.windows.map((w, i) => (
        <span key={w.key} className={`uw ${level(w.used)} ${i > 1 ? "hide-mobile" : ""}`}>
          <span className="uw-label">{w.label}</span>
          <span className="uw-meter">
            <span style={{ width: `${Math.min(100, w.used)}%` }} />
          </span>
          <span className="uw-num">{100 - w.used}% left</span>
          {w.resets_at && <span className="uw-reset muted hide-mobile">· {resetsIn(w.resets_at)}</span>}
        </span>
      ))}
      {usage.stale && <span className="muted small">as of {fetched}</span>}
    </button>
  );
}
